//! Checks LoRA files against a diffusion model and writes Kokon's copies (dev tool).
//!
//!     cargo run -p qls-core --example lora_prepare -- <model.gguf> <out dir> <lora.safetensors>...

use std::path::PathBuf;

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [model, out, loras @ ..] = args.as_slice() else {
        eprintln!("usage: lora_prepare <model> <out dir> <lora.safetensors>...");
        std::process::exit(2);
    };
    let shapes = qls_core::modelfile::diffusion_tensor_shapes(model).expect("read the model");
    std::fs::create_dir_all(out).unwrap();
    for l in loras {
        match qls_core::lora::check(l, &shapes) {
            Ok(c) => {
                let dest = out.join(l.file_name().unwrap());
                qls_core::lora::prepare(l, &dest).unwrap();
                println!("{}: {c:?}", l.display());
            }
            Err(e) => println!("{}: REFUSED {}", l.display(), e.message),
        }
    }
}
