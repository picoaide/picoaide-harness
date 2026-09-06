//! 构建时把 migrations-pg/*.sql 生成为嵌入式 Rust 模块（发布二进制自包含）。

use std::fs;

fn main() {
    let mut items = String::new();
    items.push_str("// 自动生成：migrations-pg/*.sql 编译期嵌入。\n// 请勿手工编辑。\n\n");
    items.push_str("use super::Migration;\n\n");
    items.push_str("pub fn all_migrations() -> Vec<Migration> {\n    vec![\n");
    let src = "migrations-pg";
    if let Ok(entries) = fs::read_dir(src) {
        let mut files: Vec<_> = entries.flatten().collect();
        files.sort_by_key(|e| e.file_name());
        for e in files {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".sql") {
                continue;
            }
            let content = fs::read_to_string(e.path()).unwrap_or_default();
            let version = name.split('_').next().unwrap_or("0");
            items.push_str(&format!(
                "        Migration {{ version: {}, name: {:?}.into(), sql: r#\"{}\"#.into() }},\n",
                version, name, content
            ));
        }
    }
    items.push_str("    ]\n}\n");
    fs::write("src/migrations_embedded.rs", items).expect("write");
    println!("cargo:rerun-if-changed=migrations-pg");
    println!("cargo:rerun-if-changed=build.rs");
}
