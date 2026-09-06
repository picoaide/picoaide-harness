//! 构建时嵌入 webadmin dist（从仓库 server/webadmin/dist 复制到 crate 目录）。
//! 若 dist 不存在（未构建前端），复制占位文件保证目录非空。

use std::fs;

fn main() {
    let src = "../../../server/webadmin/dist";
    let dst = "webadmin_dist";
    let _ = fs::create_dir_all(dst);
    if let Ok(entries) = fs::read_dir(src) {
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name();
            let target = std::path::Path::new(dst).join(&name);
            if path.is_dir() {
                let _ = fs::create_dir_all(&target);
            } else if path.is_file() {
                let _ = fs::copy(&path, &target);
            }
        }
    } else {
        // dist 不存在：写占位
        let _ = fs::write(format!("{dst}/index.html"), "<!doctype html><html><body>webadmin not built</body></html>");
    }
    println!("cargo:rerun-if-changed=../../../server/webadmin/dist");
}
