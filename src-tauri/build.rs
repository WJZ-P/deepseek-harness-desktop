fn main() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
    );
    let runtime_dir = manifest_dir.join("..").join("release-runtime");
    std::fs::create_dir_all(&runtime_dir).expect("create release-runtime placeholder directory");
    for name in ["node.exe", "harness.tar.gz"] {
        let path = runtime_dir.join(name);
        if !path.exists() {
            std::fs::write(path, []).expect("write release-runtime placeholder");
        }
    }
    tauri_build::build()
}
