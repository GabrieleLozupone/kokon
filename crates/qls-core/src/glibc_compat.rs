//! The C23 number parsers glibc 2.38 added, for glibc 2.35 (Ubuntu 22.04, which the .deb, .rpm and
//! Docker image are built on and run on). The ONNX Runtime `ort` downloads for Linux (AI watermark,
//! fast stickers) was compiled against glibc 2.38+, where `strtol` and friends become
//! `__isoc23_strtol` etc.: linking it on 22.04 failed with exactly these three undefined (0.12.0,
//! 2026-11-04). They differ from the classic ones only in also reading a "0b" prefix with base 0 or 2,
//! which ONNX Runtime does not use (it parses its own model and config numbers); on newer glibc these
//! stand in for glibc's with the same results.

use std::os::raw::{c_char, c_int, c_long, c_longlong, c_ulonglong};

unsafe extern "C" {
    fn strtol(s: *const c_char, end: *mut *mut c_char, base: c_int) -> c_long;
    fn strtoll(s: *const c_char, end: *mut *mut c_char, base: c_int) -> c_longlong;
    fn strtoull(s: *const c_char, end: *mut *mut c_char, base: c_int) -> c_ulonglong;
}

/// # Safety
/// As C `strtol`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn __isoc23_strtol(s: *const c_char, end: *mut *mut c_char, base: c_int) -> c_long {
    unsafe { strtol(s, end, base) }
}

/// # Safety
/// As C `strtoll`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn __isoc23_strtoll(s: *const c_char, end: *mut *mut c_char, base: c_int) -> c_longlong {
    unsafe { strtoll(s, end, base) }
}

/// # Safety
/// As C `strtoull`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn __isoc23_strtoull(s: *const c_char, end: *mut *mut c_char, base: c_int) -> c_ulonglong {
    unsafe { strtoull(s, end, base) }
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;

    #[test]
    fn they_parse_like_the_classic_ones() {
        let s = CString::new("  -42xyz").unwrap();
        let mut end = std::ptr::null_mut();
        let v = unsafe { super::__isoc23_strtol(s.as_ptr(), &mut end, 10) };
        assert_eq!(v, -42);
        assert_eq!(unsafe { end.offset_from(s.as_ptr()) }, 5);
        let h = CString::new("ff").unwrap();
        assert_eq!(unsafe { super::__isoc23_strtoll(h.as_ptr(), std::ptr::null_mut(), 16) }, 255);
        let u = CString::new("18446744073709551615").unwrap();
        assert_eq!(unsafe { super::__isoc23_strtoull(u.as_ptr(), std::ptr::null_mut(), 10) }, u64::MAX);
    }
}
