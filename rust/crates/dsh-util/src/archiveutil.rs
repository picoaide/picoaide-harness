//! 归档工具（Go `server/internal/archiveutil` 的 Rust 移植）。
//!
//! 技能/预设商店的共享归档安全检查：zip（新格式）与 gzipped tar（旧格式）
//! 都接受，格式按魔数探测。所有错误是 [`ArchiveError`] 分类；调用方映射
//! 到自身错误体系。

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;

/// 单归档界限：原始字节数、解压后总字节数、条目数与根目录必需文件。
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_archive_bytes: usize,
    pub max_unpacked_bytes: u64,
    pub max_entries: usize,
    pub required_file: String,
}

/// 归档校验失败分类（对应 Go ErrNoRequired/ErrUnsafe/ErrTooMany/ErrInvalid）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArchiveError {
    /// 归档结构非法（过大 / 容器损坏 / 非要求的格式）。
    #[error("archive invalid")]
    Invalid,
    /// 条目路径越界或者是链接文件。
    #[error("unsafe archive")]
    Unsafe,
    /// 归档根目录没有必需文件。
    #[error("archive has no required file at its root")]
    NoRequired,
    /// 条目过多。
    #[error("archive has too many entries")]
    TooMany,
}

/// 逐文件提取结果（Go ExtractFileContent 的返回元组结构化）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileExtract {
    pub content: String,
    pub size: u64,
    pub found: bool,
    /// 非 UTF-8（二进制）。
    pub binary: bool,
    /// 超过预览上限——不返回正文。
    pub too_large: bool,
}

/// Format 返回 "zip" 或 "tar.gz"（魔数匹配），否则 ""（调用方按非法处理）。
pub fn format(data: &[u8]) -> &'static str {
    if data.len() >= 4 && data[0] == b'P' && data[1] == b'K' && (data[2] == 3 || data[2] == 5 || data[2] == 7)
    {
        "zip"
    } else if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
        "tar.gz"
    } else {
        ""
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Validate 列归档（不解压），拒绝不安全条目并限制大小/条目数，要求
/// `lim.required_file` 在根目录（平铺，无前导目录段）。返回 sha256 hex。
pub fn validate(data: &[u8], lim: &Limits) -> Result<String, ArchiveError> {
    if data.is_empty() || data.len() > lim.max_archive_bytes {
        return Err(ArchiveError::Invalid);
    }
    let sum = sha256_hex(data);
    match format(data) {
        "zip" => validate_zip(data, lim)?,
        "tar.gz" => validate_tar(data, lim)?,
        _ => return Err(ArchiveError::Invalid),
    }
    Ok(sum)
}

/// ListContents 列出归档的非目录条目路径（排序、去重），并返回顶层必需文件
/// 的正文（上限 max_preview；更大 → 空串）。
pub fn list_contents(
    data: &[u8],
    lim: &Limits,
    max_preview: u64,
) -> Result<(Vec<String>, String), ArchiveError> {
    match format(data) {
        "zip" => zip_list(data, lim, max_preview),
        "tar.gz" => tar_list(data, lim, max_preview),
        _ => Err(ArchiveError::Invalid),
    }
}

/// ExtractFileContent 按归一化路径取单个文件文本内容。二进制（非 UTF-8）与
/// 超限条目以标志返回而不给正文。
pub fn extract_file_content(
    data: &[u8],
    target: &str,
    max_preview: u64,
) -> Result<FileExtract, ArchiveError> {
    match format(data) {
        "zip" => zip_extract(data, target, max_preview),
        "tar.gz" => tar_extract(data, target, max_preview),
        _ => Err(ArchiveError::Invalid),
    }
}

/// ReadAll 将归档全部普通文件解压进内存，受 lim 界限（拒绝越界路径与链接项）。
pub fn read_all(data: &[u8], lim: &Limits) -> Result<HashMap<String, Vec<u8>>, ArchiveError> {
    match format(data) {
        "zip" => zip_read_all(data, lim),
        "tar.gz" => tar_read_all(data, lim),
        _ => Err(ArchiveError::Invalid),
    }
}

/// WriteZip 将文件打包成确定性的 zip（条目按名排序、固定时间戳），供规范化
/// 流程重新打包归档。
pub fn write_zip(files: &HashMap<String, Vec<u8>>) -> Result<Vec<u8>, ArchiveError> {
    let mut names: Vec<&String> = files.keys().collect();
    names.sort();
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zw = zip::ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::DEFAULT)
            .unix_permissions(0o644);
        for name in names {
            zw.start_file(name.as_str(), opts)
                .map_err(|_| ArchiveError::Invalid)?;
            zw.write_all(&files[name]).map_err(|_| ArchiveError::Invalid)?;
        }
        zw.finish().map_err(|_| ArchiveError::Invalid)?;
    }
    Ok(cursor.into_inner())
}

/// NormalizePath 归一化归档条目路径，拒绝绝对路径与父目录穿越。返回 `""`
/// 表示打包根自身（`./`），属结构性且安全。
pub fn normalize_path(raw: &str) -> Result<String, ArchiveError> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    // 绝对路径（正斜杠/反斜杠/Windows 盘符）在归一前拒绝——`\etc` 或
    // `C:\x` 经替换与空段折叠会被静默变相对路径放行（与 Go 对齐）。
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(ArchiveError::Unsafe);
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(ArchiveError::Unsafe);
    }
    let mut out: Vec<&str> = Vec::new();
    let replaced = raw.replace('\\', "/");
    for seg in replaced.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err(ArchiveError::Unsafe),
            s => out.push(s),
        }
    }
    Ok(out.join("/"))
}

/// ErrorText 将错误映射为人读（中文）描述（对应 Go ErrorText）。
pub fn error_text(err: &ArchiveError, required_name: &str, max_archive_mb: usize) -> String {
    match err {
        ArchiveError::NoRequired => format!("归档缺少 {required_name}"),
        ArchiveError::Unsafe => "归档内容不安全(路径越界或链接文件)".to_string(),
        ArchiveError::TooMany => "归档条目过多".to_string(),
        ArchiveError::Invalid => format!("归档过大或结构非法(上限 {max_archive_mb}MB)"),
    }
}

// ------------------------------ zip ------------------------------

fn validate_zip(data: &[u8], lim: &Limits) -> Result<(), ArchiveError> {
    let mut zr = zip::ZipArchive::new(Cursor::new(data)).map_err(|_| ArchiveError::Invalid)?;
    if zr.len() > lim.max_entries {
        return Err(ArchiveError::TooMany);
    }
    let mut total: u64 = 0;
    let mut has_required = false;
    for i in 0..zr.len() {
        let f = zr.by_index(i).map_err(|_| ArchiveError::Invalid)?;
        let is_dir = f.is_dir();
        let norm = normalize_path(f.name())?;
        let size = f.size();
        if size > lim.max_unpacked_bytes || total + size > lim.max_unpacked_bytes {
            return Err(ArchiveError::Invalid);
        }
        total += size;
        if is_dir {
            continue;
        }
        if norm.is_empty() {
            return Err(ArchiveError::Unsafe);
        }
        if f.is_symlink() {
            return Err(ArchiveError::Unsafe);
        }
        if norm == lim.required_file {
            has_required = true;
        }
    }
    if !has_required {
        return Err(ArchiveError::NoRequired);
    }
    Ok(())
}

fn zip_list(data: &[u8], lim: &Limits, max_preview: u64) -> Result<(Vec<String>, String), ArchiveError> {
    let mut zr = zip::ZipArchive::new(Cursor::new(data)).map_err(|_| ArchiveError::Invalid)?;
    if zr.len() > lim.max_entries {
        return Err(ArchiveError::TooMany);
    }
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut required = String::new();
    for i in 0..zr.len() {
        let mut f = zr.by_index(i).map_err(|_| ArchiveError::Invalid)?;
        if f.is_symlink() {
            return Err(ArchiveError::Unsafe);
        }
        let norm = normalize_path(f.name())?;
        if f.is_dir() || norm.is_empty() {
            continue;
        }
        set.insert(norm.clone());
        if norm == lim.required_file && required.is_empty() && f.size() <= max_preview {
            let mut buf = Vec::new();
            (&mut f as &mut dyn Read)
                .take(max_preview + 1)
                .read_to_end(&mut buf)
                .map_err(|_| ArchiveError::Invalid)?;
            required = String::from_utf8_lossy(&buf).to_string();
        }
    }
    Ok((set.into_iter().collect(), required))
}

fn zip_extract(
    data: &[u8],
    target: &str,
    max_preview: u64,
) -> Result<FileExtract, ArchiveError> {
    let mut zr = zip::ZipArchive::new(Cursor::new(data)).map_err(|_| ArchiveError::Invalid)?;
    for i in 0..zr.len() {
        let mut f = zr.by_index(i).map_err(|_| ArchiveError::Invalid)?;
        if f.is_symlink() {
            return Err(ArchiveError::Unsafe);
        }
        let name = normalize_path(f.name());
        let Ok(name) = name else { continue };
        if name.is_empty() || f.is_dir() || name != target {
            continue;
        }
        let size = f.size();
        if size > max_preview {
            return Ok(FileExtract {
                size,
                found: true,
                too_large: true,
                ..Default::default()
            });
        }
        // 声明大小可伪造（小声明+高压缩比 = zip 炸弹）：按实际解压字节设
        // 硬上限，超出即按 tooLarge 返回——与 list 一致（2026-09-01 审计）。
        let mut buf = Vec::new();
        (&mut f as &mut dyn Read)
            .take(max_preview + 1)
            .read_to_end(&mut buf)
            .map_err(|_| ArchiveError::Invalid)?;
        if buf.len() as u64 > max_preview {
            return Ok(FileExtract {
                size: buf.len() as u64,
                found: true,
                too_large: true,
                ..Default::default()
            });
        }
        if std::str::from_utf8(&buf).is_err() {
            return Ok(FileExtract {
                size,
                found: true,
                binary: true,
                ..Default::default()
            });
        }
        return Ok(FileExtract {
            content: String::from_utf8_lossy(&buf).to_string(),
            size,
            found: true,
            ..Default::default()
        });
    }
    Ok(FileExtract::default())
}

// ------------------------------ tar.gz ------------------------------

fn validate_tar(data: &[u8], lim: &Limits) -> Result<(), ArchiveError> {
    let mut gz = GzDecoder::new(data);
    let mut ar = tar::Archive::new(&mut gz);
    let mut total: u64 = 0;
    let mut entries = 0usize;
    let mut has_required = false;
    for entry in ar.entries().map_err(|_| ArchiveError::Unsafe)? {
        entries += 1;
        if entries > lim.max_entries {
            return Err(ArchiveError::TooMany);
        }
        let e = entry.map_err(|_| ArchiveError::Unsafe)?;
        let ty = e.header().entry_type();
        if ty.is_symlink() || ty.is_hard_link() {
            return Err(ArchiveError::Unsafe);
        }
        let name = e
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|_| ArchiveError::Unsafe)?;
        if ty.is_dir() {
            continue;
        }
        let norm = normalize_path(&name)?;
        if norm.is_empty() {
            return Err(ArchiveError::Unsafe);
        }
        total += e.size();
        if total > lim.max_unpacked_bytes {
            return Err(ArchiveError::Invalid);
        }
        if norm == lim.required_file {
            has_required = true;
        }
    }
    if !has_required {
        return Err(ArchiveError::NoRequired);
    }
    Ok(())
}

fn tar_list(
    data: &[u8],
    lim: &Limits,
    max_preview: u64,
) -> Result<(Vec<String>, String), ArchiveError> {
    let mut gz = GzDecoder::new(data);
    let mut ar = tar::Archive::new(&mut gz);
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut required = String::new();
    let mut entries = 0usize;
    for entry in ar.entries().map_err(|_| ArchiveError::Unsafe)? {
        entries += 1;
        if entries > lim.max_entries {
            return Err(ArchiveError::TooMany);
        }
        let mut e = entry.map_err(|_| ArchiveError::Unsafe)?;
        let ty = e.header().entry_type();
        if ty.is_dir() || ty.is_symlink() || ty.is_hard_link() {
            continue;
        }
        let name = e
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|_| ArchiveError::Unsafe)?;
        let norm = normalize_path(&name)?;
        if norm.is_empty() {
            continue;
        }
        set.insert(norm.clone());
        if norm == lim.required_file && required.is_empty() && e.size() <= max_preview {
            let mut buf = Vec::new();
            (&mut e as &mut dyn Read)
                .take(max_preview + 1)
                .read_to_end(&mut buf)
                .map_err(|_| ArchiveError::Invalid)?;
            required = String::from_utf8_lossy(&buf).to_string();
        }
    }
    Ok((set.into_iter().collect(), required))
}

fn tar_extract(
    data: &[u8],
    target: &str,
    max_preview: u64,
) -> Result<FileExtract, ArchiveError> {
    let mut gz = GzDecoder::new(data);
    let mut ar = tar::Archive::new(&mut gz);
    for entry in ar.entries().map_err(|_| ArchiveError::Unsafe)? {
        let mut e = entry.map_err(|_| ArchiveError::Unsafe)?;
        let ty = e.header().entry_type();
        if ty.is_dir() || ty.is_symlink() || ty.is_hard_link() {
            continue;
        }
        let name = e
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|_| ArchiveError::Unsafe)?;
        let norm = normalize_path(&name).unwrap_or_default();
        if norm.is_empty() || norm != target {
            continue;
        }
        let size = e.size();
        if size > max_preview {
            return Ok(FileExtract {
                size,
                found: true,
                too_large: true,
                ..Default::default()
            });
        }
        let mut buf = Vec::new();
        (&mut e as &mut dyn Read)
            .take(max_preview + 1)
            .read_to_end(&mut buf)
            .map_err(|_| ArchiveError::Unsafe)?;
        if std::str::from_utf8(&buf).is_err() {
            return Ok(FileExtract {
                size,
                found: true,
                binary: true,
                ..Default::default()
            });
        }
        return Ok(FileExtract {
            content: String::from_utf8_lossy(&buf).to_string(),
            size,
            found: true,
            ..Default::default()
        });
    }
    Ok(FileExtract::default())
}

fn tar_read_all(data: &[u8], lim: &Limits) -> Result<HashMap<String, Vec<u8>>, ArchiveError> {
    let mut gz = GzDecoder::new(data);
    let mut ar = tar::Archive::new(&mut gz);
    let mut out = HashMap::new();
    let mut total: u64 = 0;
    let mut entries = 0usize;
    let iter = ar.entries().map_err(|_| ArchiveError::Invalid)?;
    for entry in iter {
        entries += 1;
        if entries > lim.max_entries {
            return Err(ArchiveError::TooMany);
        }
        let mut e = entry.map_err(|_| ArchiveError::Invalid)?;
        let ty = e.header().entry_type();
        if ty.is_symlink() || ty.is_hard_link() {
            return Err(ArchiveError::Unsafe);
        }
        let name = e
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|_| ArchiveError::Invalid)?;
        let norm = normalize_path(&name)?;
        if norm.is_empty() || ty.is_dir() {
            continue;
        }
        let mut buf = Vec::new();
        (&mut e as &mut dyn Read)
            .take(lim.max_unpacked_bytes)
            .read_to_end(&mut buf)
            .map_err(|_| ArchiveError::Invalid)?;
        total += buf.len() as u64;
        if total > lim.max_unpacked_bytes {
            return Err(ArchiveError::Invalid);
        }
        out.insert(norm, buf);
    }
    Ok(out)
}

fn zip_read_all(data: &[u8], lim: &Limits) -> Result<HashMap<String, Vec<u8>>, ArchiveError> {
    let mut zr = zip::ZipArchive::new(Cursor::new(data)).map_err(|_| ArchiveError::Invalid)?;
    if zr.len() > lim.max_entries {
        return Err(ArchiveError::TooMany);
    }
    let mut out = HashMap::new();
    let mut total: u64 = 0;
    for i in 0..zr.len() {
        let mut f = zr.by_index(i).map_err(|_| ArchiveError::Invalid)?;
        if f.is_symlink() {
            return Err(ArchiveError::Unsafe);
        }
        let norm = normalize_path(f.name())?;
        if norm.is_empty() || f.is_dir() {
            continue;
        }
        let mut buf = Vec::new();
        (&mut f as &mut dyn Read)
            .take(lim.max_unpacked_bytes)
            .read_to_end(&mut buf)
            .map_err(|_| ArchiveError::Invalid)?;
        total += buf.len() as u64;
        if total > lim.max_unpacked_bytes {
            return Err(ArchiveError::Invalid);
        }
        out.insert(norm, buf);
    }
    Ok(out)
}

// ------------------------------ tests ------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_lim() -> Limits {
        Limits {
            max_archive_bytes: 1 << 20,
            max_unpacked_bytes: 4 << 20,
            max_entries: 100,
            required_file: "SKILL.md".to_string(),
        }
    }

    fn make_zip(entries: &[(&str, &[u8])], symlink: bool) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, content) in entries {
                if symlink && *name == "link" {
                    zw.add_symlink(*name, "target", SimpleFileOptions::default())
                        .unwrap();
                } else {
                    zw.start_file(*name, opts).unwrap();
                    zw.write_all(content).unwrap();
                }
            }
            zw.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn make_tar_gz(entries: &[(&str, &str)], symlink: bool) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut tw = tar::Builder::new(&mut gz);
            for (name, content) in entries {
                let mut h = tar::Header::new_gnu();
                if symlink && *name == "link" {
                    h.set_entry_type(tar::EntryType::Symlink);
                    h.set_size(0);
                    h.set_mode(0o777);
                } else {
                    h.set_entry_type(tar::EntryType::Regular);
                    h.set_size(content.len() as u64);
                    h.set_mode(0o644);
                }
                h.set_path(name).unwrap();
                h.set_cksum();
                tw.append(&h, content.as_bytes()).unwrap();
            }
            tw.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    /// 手写 tar 头（绕开 tar crate 对 `..`/绝对路径的写入校验），用于构造
    /// 恶意归档测试数据。(name, content, typeflag: 0=regular, 2=symlink)
    fn make_tar_gz_raw(entries: &[(&str, &[u8], u8)]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        for (name, content, ty) in entries {
            let mut h = [0u8; 512];
            let nb = name.as_bytes();
            let n = nb.len().min(100);
            h[..n].copy_from_slice(&nb[..n]);
            h[100..108].copy_from_slice(b"0000644\0");
            h[108..116].copy_from_slice(b"0000000\0");
            h[116..124].copy_from_slice(b"0000000\0");
            let payload_len = if *ty == 2 { 0 } else { content.len() };
            let size_str = format!("{:011o}\0", payload_len);
            h[124..136].copy_from_slice(size_str.as_bytes());
            let mtime = format!("{:011o}\0", 0u64);
            h[136..148].copy_from_slice(mtime.as_bytes());
            h[148..156].copy_from_slice(b"        "); // checksum 占位（空格）
            h[156] = *ty;
            if *ty == 2 {
                h[157..163].copy_from_slice(b"target");
            }
            h[257..263].copy_from_slice(b"ustar\0");
            h[263..265].copy_from_slice(b"00");
            let sum: u32 = h.iter().map(|&b| b as u32).sum();
            let cksum = format!("{:06o}\0 ", sum);
            h[148..156].copy_from_slice(cksum.as_bytes());
            tar_bytes.extend_from_slice(&h);
            tar_bytes.extend_from_slice(content);
            tar_bytes.extend(std::iter::repeat(0u8).take((512 - content.len() % 512) % 512));
        }
        tar_bytes.extend_from_slice(&[0u8; 1024]);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar_bytes).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn format_magic() {
        assert_eq!(format(b"PK\x03\x04\x00\x00"), "zip");
        assert_eq!(format(b"\x1f\x8b\x08\x00"), "tar.gz");
        assert_eq!(format(b"xyzw"), "");
        assert_eq!(format(&[]), "");
    }

    #[test]
    fn validate_zip() {
        let data = make_zip(
            &[("SKILL.md", b"# demo"), ("tools/run.sh", b"x")],
            false,
        );
        let sum = validate(&data, &test_lim()).unwrap();
        assert_eq!(sum.len(), 64);

        // 缺必需文件
        let err = validate(
            &make_zip(&[("readme.md", b"x")], false),
            &test_lim(),
        )
        .unwrap_err();
        assert_eq!(err, ArchiveError::NoRequired);
        // 路径穿越
        let err = validate(
            &make_zip(&[("SKILL.md", b"x"), ("../evil", b"x")], false),
            &test_lim(),
        )
        .unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);
        // 绝对路径
        let err = validate(
            &make_zip(&[("SKILL.md", b"x"), ("/etc/passwd", b"x")], false),
            &test_lim(),
        )
        .unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);
        // 符号链接
        let err = validate(
            &make_zip(&[("SKILL.md", b"x"), ("link", b"target")], true),
            &test_lim(),
        )
        .unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);
        // 垃圾数据
        let err = validate(b"not an archive", &test_lim()).unwrap_err();
        assert_eq!(err, ArchiveError::Invalid);
        // 超限
        let mut big = vec![b'P', b'K', 3, 4];
        big.extend(std::iter::repeat(0u8).take(2_000_000));
        let err = validate(&big, &test_lim()).unwrap_err();
        assert_eq!(err, ArchiveError::Invalid);
    }

    #[test]
    fn validate_tar_gz() {
        let data = make_tar_gz(&[("SKILL.md", "# demo"), ("tools/run.sh", "x")], false);
        assert!(validate(&data, &test_lim()).is_ok());

        let err = validate(
            &make_tar_gz_raw(&[("SKILL.md", b"x", 0), ("../evil", b"x", 0)]),
            &test_lim(),
        )
        .unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);

        let err = validate(
            &make_tar_gz_raw(&[("SKILL.md", b"x", 0), ("/etc/passwd", b"x", 0)]),
            &test_lim(),
        )
        .unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);

        let err = validate(
            &make_tar_gz_raw(&[("SKILL.md", b"x", 0), ("link", b"target", 2)]),
            &test_lim(),
        )
        .unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);

        let err = validate(&make_tar_gz(&[("readme.md", "x")], false), &test_lim()).unwrap_err();
        assert_eq!(err, ArchiveError::NoRequired);
    }

    #[test]
    fn list_contents_zip() {
        let data = make_zip(
            &[
                ("SKILL.md", b"---\nname: demo\n---\n# hi"),
                ("tools/run.sh", b"x"),
                ("b.txt", b"y"),
            ],
            false,
        );
        let (files, content) = list_contents(&data, &test_lim(), 1 << 20).unwrap();
        assert_eq!(files, vec!["SKILL.md", "b.txt", "tools/run.sh"]);
        assert!(content.contains("name: demo"));
    }

    #[test]
    fn list_contents_tar_gz() {
        let data = make_tar_gz(&[("SKILL.md", "---\nname: demo\n---"), ("a.txt", "x")], false);
        let (files, content) = list_contents(&data, &test_lim(), 1 << 20).unwrap();
        assert_eq!(files.len(), 2);
        assert!(content.contains("name: demo"));
    }

    #[test]
    fn extract_file_content_zip() {
        let data = make_zip(
            &[
                ("SKILL.md", b"# hi"),
                ("a/b/c.md", b"nested"),
                ("bin.dat", &[0xff, 0xfe, 0x00]),
            ],
            false,
        );
        let r = extract_file_content(&data, "a/b/c.md", 1 << 20).unwrap();
        assert!(r.found && !r.binary && !r.too_large && r.content == "nested" && r.size == 6);

        let r = extract_file_content(&data, "bin.dat", 1 << 20).unwrap();
        assert!(r.found && r.binary);

        let r = extract_file_content(&data, "SKILL.md", 2).unwrap();
        assert!(r.found && r.too_large && r.size == 4);

        let r = extract_file_content(&data, "missing.md", 1 << 20).unwrap();
        assert!(!r.found);
    }

    #[test]
    fn extract_file_content_tar_gz() {
        let data = make_tar_gz(&[("SKILL.md", "# hi"), ("a.md", "x")], false);
        let r = extract_file_content(&data, "a.md", 1 << 20).unwrap();
        assert!(r.found && r.content == "x");
    }

    #[test]
    fn normalize_path_cases() {
        let cases: &[(&str, &str, bool)] = &[
            ("", "", false),
            ("./", "", false),
            ("./a/b", "a/b", false),
            ("a//b", "a/b", false),
            ("a/./b", "a/b", false),
            ("../a", "", true),
            ("a/../../b", "", true),
            ("/etc/passwd", "", true),
            ("\\etc\\passwd", "", true),
            ("C:\\x\\y", "", true),
            ("c:/x", "", true),
            ("a\\b/c", "a/b/c", false),
        ];
        for (raw, want, want_err) in cases {
            match normalize_path(raw) {
                Ok(got) => {
                    assert!(!want_err, "NormalizePath({raw:?}) = {got:?}, want error");
                    assert_eq!(got, *want);
                }
                Err(e) => {
                    assert!(*want_err, "NormalizePath({raw:?}) err = {e:?}, want ok");
                    assert_eq!(e, ArchiveError::Unsafe);
                }
            }
        }
    }

    #[test]
    fn validate_zip_bomb() {
        // 头部声明很小、实际解压远超上限的极端条目必须被拒绝。
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zw.start_file("SKILL.md", opts).unwrap();
            let big = "AAAA".repeat(2 << 20); // 8MB 未压缩
            zw.write_all(big.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let data = cursor.into_inner();
        let err = validate(&data, &test_lim()).unwrap_err();
        assert_eq!(err, ArchiveError::Invalid);
    }

    #[test]
    fn read_all_zip_and_tar_gz() {
        let zip_data = make_zip(&[("SKILL.md", b"# Skill\n"), ("img.png", b"\x89PNG")], false);
        let files = read_all(&zip_data, &test_lim()).unwrap();
        assert_eq!(files["SKILL.md"], b"# Skill\n");
        assert_eq!(files["img.png"], b"\x89PNG");

        // tar.gz 带目录条目 + 文件
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut tw = tar::Builder::new(&mut gz);
            let mut dh = tar::Header::new_gnu();
            dh.set_entry_type(tar::EntryType::Directory);
            dh.set_size(0);
            dh.set_mode(0o755);
            dh.set_path("dir").unwrap();
            dh.set_cksum();
            tw.append(&dh, &b""[..]).unwrap();

            let mut fh = tar::Header::new_gnu();
            fh.set_entry_type(tar::EntryType::Regular);
            fh.set_size(5);
            fh.set_mode(0o644);
            fh.set_path("dir/SKILL.md").unwrap();
            fh.set_cksum();
            tw.append(&fh, &b"hello"[..]).unwrap();
            tw.finish().unwrap();
        }
        let data = gz.finish().unwrap();
        let files = read_all(&data, &test_lim()).unwrap();
        assert_eq!(files["dir/SKILL.md"], b"hello");
        assert!(!files.contains_key("dir"));
    }

    #[test]
    fn read_all_rejects_symlinks_and_bad_containers() {
        let zip_data = make_zip(&[("SKILL.md", b"x"), ("link", b"etc/passwd")], true);
        let err = read_all(&zip_data, &test_lim()).unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);

        let tar_data = make_tar_gz(&[("SKILL.md", "x"), ("link", "etc/passwd")], true);
        let err = read_all(&tar_data, &test_lim()).unwrap_err();
        assert_eq!(err, ArchiveError::Unsafe);

        let err = read_all(b"not an archive", &test_lim()).unwrap_err();
        assert_eq!(err, ArchiveError::Invalid);
    }

    #[test]
    fn write_zip_roundtrip() {
        let mut files = HashMap::new();
        files.insert("z.txt".to_string(), b"last".to_vec());
        files.insert("a.txt".to_string(), b"first".to_vec());
        files.insert("SKILL.md".to_string(), b"# T\n".to_vec());
        files.insert("sub/x.txt".to_string(), b"nested".to_vec());

        let data = write_zip(&files).unwrap();
        let sum = validate(&data, &test_lim()).unwrap();
        assert!(!sum.is_empty());

        // 确定性：写两次字节一致（固定时间戳 + 排序条目）。
        let again = write_zip(&files).unwrap();
        assert_eq!(data, again);

        let out = read_all(&data, &test_lim()).unwrap();
        assert_eq!(out["SKILL.md"], b"# T\n");
        assert_eq!(out["a.txt"], b"first");
    }

    #[test]
    fn test_error_text() {
        assert!(!error_text(&ArchiveError::NoRequired, "SKILL.md", 16).is_empty());
        assert!(!error_text(&ArchiveError::Unsafe, "SKILL.md", 16).is_empty());
        assert!(error_text(&ArchiveError::NoRequired, "SKILL.md", 10).contains("SKILL.md"));
        assert!(error_text(&ArchiveError::Invalid, "SKILL.md", 10).contains("10"));
        assert!(error_text(&ArchiveError::Invalid, "SKILL.md", 10).contains("上限"));
    }
}
