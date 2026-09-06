//! 构建时把 webadmin dist（server/webadmin/dist）递归复制到 crate 的 webadmin_dist。
//! 发布二进制运行时从 webadmin_dist/ 读取（需随二进制一起部署）。

use std::fs;
use std::path::Path;

fn copy_dir_recursive(src: &Path, dst: &Path) {
    if let Ok(entries) = fs::read_dir(src) {
        let _ = fs::create_dir_all(dst);
        for e in entries.flatten() {
            let path = e.path();
            let target = dst.join(e.file_name());
            if path.is_dir() {
                copy_dir_recursive(&path, &target);
            } else if path.is_file() {
                let _ = fs::copy(&path, &target);
            }
        }
    }
}

fn main() {
    let src = Path::new("../../../server/webadmin/dist");
    let dst = Path::new("webadmin_dist");
    let _ = fs::create_dir_all(dst);
    copy_dir_recursive(src, dst);
    // 占位 index（若未构建）
    if !dst.join("index.html").exists() {
        let _ = fs::write(dst.join("index.html"), "<!doctype html><html><body>webadmin not built</body></html>");
    }
    println!("cargo:rerun-if-changed=webadmin_dist_src");
    println!("cargo:rerun-if-changed=build.rs");
}
