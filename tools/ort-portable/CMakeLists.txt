# Bundles ONNX Runtime's static libraries (and the object files of its object libraries) into one
# libonnxruntime.a, the layout `ort-sys` expects when `ORT_LIB_LOCATION` points at the install
# folder's `lib/`.
#
# Based on pykeio/ort-artifacts `src/static-build/CMakeLists.txt` (Apache-2.0). The difference
# is in how this directory is configured: the build script passes `-march=x86-64-v2` and
# `-Donnxruntime_USE_AVX=OFF -Donnxruntime_USE_AVX2=OFF -Donnxruntime_USE_AVX512=OFF`, so the
# baseline runs on SSE4.2 CPUs while MLAS still compiles its AVX/AVX2/AVX-512 kernels (each
# with its own flags) and chooses one at runtime. That is what lets one binary run on a Xeon
# X5670 and use AVX2/AVX-512 on newer processors.
cmake_minimum_required(VERSION 3.26)
project(onnxruntime_static_lib LANGUAGES C CXX)

# The shared target is built (but not shipped) so its static dependencies can be collected.
set(onnxruntime_BUILD_SHARED_LIB ON)

add_definitions(-D_SILENCE_ALL_CXX23_DEPRECATION_WARNINGS)

add_subdirectory(${ONNXRUNTIME_SOURCE_DIR}/cmake onnxruntime EXCLUDE_FROM_ALL)

function(bundle_static_library bundled_target_name)
    set(extension_blocklist
        .dylib
        .so
        .dll
        .tbd
    )

    function(recursively_collect_dependencies input_target)
        if(NOT TARGET ${input_target})
            if(EXISTS ${input_target})
                get_filename_component(extension "${input_target}" EXT)

                if(NOT extension IN_LIST extension_blocklist)
                    list(APPEND static_libs "${input_target}")
                    set(static_libs ${static_libs} PARENT_SCOPE)
                endif()
            endif()

            return()
        endif()

        get_target_property(alias ${input_target} ALIASED_TARGET)

        if(TARGET ${alias})
            set(input_target ${alias})
        endif()

        get_property(library_already_added GLOBAL PROPERTY ${target_name}_static_bundle_${input_target})

        if(library_already_added)
            return()
        endif()

        set_property(GLOBAL PROPERTY ${target_name}_static_bundle_${input_target} ON)

        get_target_property(input_type ${input_target} TYPE)

        if(${input_type} STREQUAL "STATIC_LIBRARY")
            list(APPEND static_libs "$<TARGET_FILE:${input_target}>")
            get_target_property(dependencies ${input_target} LINK_LIBRARIES)
        elseif(${input_type} STREQUAL "OBJECT_LIBRARY")
            # An object library is not an archive, so it is bundled as its object files. They are
            # joined with spaces, not with the semicolons a generator-expression list expands to,
            # because the ar script below and a Windows response file read the names that way.
            # This is what the Windows build needs: onnxruntime_providers_cpu.cmake makes
            # onnxruntime_providers_obj an object library when MSVC builds the shared target, so
            # without this the CPU provider is not in the bundle, and the Rust link fails with 17
            # unresolved externals from core/providers/ (CPUExecutionProvider, the control-flow
            # kernels, OrtApis::CreateCpuMemoryInfo). On Linux the same sources are a static
            # archive, which is why that build links.
            list(APPEND object_files "$<JOIN:$<TARGET_OBJECTS:${input_target}>, >")
            list(APPEND object_targets "${input_target}")
            get_target_property(dependencies ${input_target} LINK_LIBRARIES)
        elseif(${input_type} STREQUAL "INTERFACE_LIBRARY")
            get_target_property(dependencies ${input_target} INTERFACE_LINK_LIBRARIES)
        else()
            get_target_property(dependencies ${input_target} LINK_LIBRARIES)
        endif()

        if(dependencies)
            foreach(dependency IN LISTS dependencies)
                recursively_collect_dependencies(${dependency})
            endforeach()
        endif()

        set(static_libs ${static_libs} PARENT_SCOPE)
        set(object_files ${object_files} PARENT_SCOPE)
        set(object_targets ${object_targets} PARENT_SCOPE)
    endfunction()

    foreach(target_name IN ITEMS ${ARGN})
        recursively_collect_dependencies(${target_name})
    endforeach()

    list(REMOVE_DUPLICATES static_libs)
    list(REMOVE_DUPLICATES object_files)
    set(static_libs ${static_libs} PARENT_SCOPE)
    set(object_files ${object_files} PARENT_SCOPE)

    file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/static_libs.txt.in)

    foreach(bundle_input IN LISTS static_libs object_files)
        file(APPEND ${CMAKE_CURRENT_BINARY_DIR}/static_libs.txt.in "${bundle_input}\n")
    endforeach()

    file(GENERATE
        OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/static_libs.txt
        INPUT ${CMAKE_CURRENT_BINARY_DIR}/static_libs.txt.in)

    set(bundled_target_full_name
        ${CMAKE_CURRENT_BINARY_DIR}/${CMAKE_STATIC_LIBRARY_PREFIX}${bundled_target_name}${CMAKE_STATIC_LIBRARY_SUFFIX})

    if(MSVC)
        set(lib ${CMAKE_AR})
        # The inputs go through the response file above rather than the command line: a CPU-only
        # build of ONNX Runtime has ~230 object files in the CPU provider's object library, and a
        # Windows command line is limited to 32767 characters.
        add_custom_command(
            COMMAND ${lib} /NOLOGO /OUT:${bundled_target_full_name} @${CMAKE_CURRENT_BINARY_DIR}/static_libs.txt
            OUTPUT ${bundled_target_full_name}
            COMMENT "Bundling ${bundled_target_name}"
            VERBATIM)
    elseif(APPLE)
        find_program(libtool libtool)
        add_custom_command(
            COMMAND ${libtool} -static -o ${bundled_target_full_name} ${static_libs} ${object_files}
            OUTPUT ${bundled_target_full_name}
            COMMENT "Bundling ${bundled_target_name}"
            VERBATIM)
    else()
        file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar.in
            "CREATE ${bundled_target_full_name}\n")

        foreach(static_lib IN LISTS static_libs)
            file(APPEND ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar.in
                "ADDLIB ${static_lib}\n")
        endforeach()

        # GNU ar's script language adds a plain object file with ADDMOD (ADDLIB only takes an
        # archive), so the two kinds of input are written as two kinds of command.
        foreach(object_file IN LISTS object_files)
            file(APPEND ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar.in
                "ADDMOD ${object_file}\n")
        endforeach()

        file(APPEND ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar.in "SAVE\n")
        file(APPEND ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar.in "END\n")

        file(GENERATE
            OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar
            INPUT ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar.in)

        set(ar ${CMAKE_AR})

        if(CMAKE_INTERPROCEDURAL_OPTIMIZATION)
            set(ar ${CMAKE_CXX_COMPILER_AR})
        endif()

        add_custom_command(
            COMMAND ${ar} -M < ${CMAKE_CURRENT_BINARY_DIR}/${bundled_target_name}.ar
            OUTPUT ${bundled_target_full_name}
            COMMENT "Bundling ${bundled_target_name}"
            VERBATIM)
    endif()

    add_custom_target(bundling_${bundled_target_name} ALL DEPENDS ${bundled_target_full_name})

    # The object files have to exist before the bundling command runs.
    foreach(target_name IN ITEMS ${ARGN} ${object_targets})
        if(TARGET ${target_name})
            add_dependencies(bundling_${bundled_target_name} ${target_name})
        endif()
    endforeach()

    add_library(${bundled_target_name} STATIC IMPORTED GLOBAL)
    set_target_properties(${bundled_target_name}
        PROPERTIES
        IMPORTED_LOCATION ${bundled_target_full_name})

    foreach(target_name IN ITEMS ${ARGN})
        set_property(TARGET ${bundled_target_name} APPEND
            PROPERTY INTERFACE_INCLUDE_DIRECTORIES $<TARGET_PROPERTY:${target_name},INTERFACE_INCLUDE_DIRECTORIES>)
        set_property(TARGET ${bundled_target_name} APPEND
            PROPERTY INTERFACE_COMPILE_DEFINITIONS $<TARGET_PROPERTY:${target_name},INTERFACE_COMPILE_DEFINITIONS>)
    endforeach()

    add_dependencies(${bundled_target_name} bundling_${bundled_target_name})
endfunction()

bundle_static_library(${PROJECT_NAME} onnxruntime)

install(
    FILES ${CMAKE_CURRENT_BINARY_DIR}/${CMAKE_STATIC_LIBRARY_PREFIX}${PROJECT_NAME}${CMAKE_STATIC_LIBRARY_SUFFIX}
    RENAME ${CMAKE_STATIC_LIBRARY_PREFIX}onnxruntime${CMAKE_STATIC_LIBRARY_SUFFIX}
    TYPE LIB
)
