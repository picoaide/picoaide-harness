// Package cachetrust 校验 **wazero 磁盘编译缓存目录**的形状是否可信。
//
// 为什么单独一个包（2026-09-21 审计 F-4）：缓存目录是**编译进程与执行进程共用**的
// 信任边界（§4.3.1-d），两侧都必须校验，而两侧**不能互相 import**（compile 不 import
// runtime、runtime 不 import compile —— 见 compile/doc.go 的依赖方向说明）。
// 把判据放在这里，两侧 import 同一个实现，就不会出现"编译侧严、执行侧松"的漂移。
//
// 判据与残余风险（逐条对应一种真实且低成本的形态）：
//   - 根目录/分片目录：真实目录（非符号链接）、无 group/other 写位、属主可读；
//   - 条目：普通文件（非符号链接/FIFO/设备）、非空、无 group/other 写位。
//
// **不校验内容**：wazero 的条目只带同文件 CRC32（挡损坏、不挡篡改），而条目会被
// 执行进程 mmap 成机器码执行 ⇒ 与宿主同 uid 的写者仍可投毒。真正闭合需要独立 uid /
// 只读挂载 / 宿主持有的 HMAC 清单；这条残余风险由调用方（compile/doc.go 的
// CacheTrustResidual）如实认账，不在这里假装解决。
package cachetrust

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// CacheTrustViolation 是一条缓存目录可信性违规（路径 + 原因，供日志/运维面展示）。
//
// 为什么返回"全部违规"而不是遇到第一条就返回：运维面需要一次看清整棵树
// （例如旧版本留下的 0777 目录 + 一条符号链接），逐条修完再重启比"修一条重启一次"省事。
type CacheTrustViolation struct {
	// Path 是违规项的绝对路径（根目录或某个子项）。
	Path string
	// Reason 是人可读的原因（中文，与平台其它诊断文案一致）。
	Reason string
}

// CacheTrustReport 是一次缓存目录校验的结果。
type CacheTrustReport struct {
	// Dir 是被校验的根目录。
	Dir string
	// Entries 是遍历到的子项数量（诊断用：0 表示缓存还是空的）。
	Entries int
	// Violations 是发现的违规（空 = 通过）。
	Violations []CacheTrustViolation
}

// Trusted 报告这次校验是否通过（无任何违规）。
func (r CacheTrustReport) Trusted() bool { return len(r.Violations) == 0 }

// VerifyCacheDirTrust 校验缓存目录树的**形状**是否可信（不读内容、不验签名）。
//
// 判据（逐条都对应一种真实的低成本投毒/泄露形态）：
//  1. 根目录必须是**真实目录**（符号链接 ⇒ 缓存被重定向到攻击者选定的位置）；
//  2. 根目录与各级子目录：权限不含 group/other **写**位（含写位 ⇒ 同机其它用户可投毒），
//     且属主可读（否则编译进程自己也读不了，属于配置错误）；
//  3. 条目必须是**普通文件**（符号链接 / FIFO / 设备节点一律拒：前两者可把
//     "读一个条目"变成"读/阻塞在别的东西上"），非空，权限不含 group/other 写位。
//
// 目录不存在**不算违规**（还没编译过任何应用）：返回空报告，由调用方决定是否创建。
//
// 认账（不假装解决）：本函数**不校验条目内容**——wazero 的条目只有 CRC32，
// 挡不住篡改；与宿主同 uid 的写者仍可投毒。真正闭合需要独立 uid / 只读挂载 /
// 宿主持有的 HMAC 清单。见 doc.go 的 `CacheTrustResidual()`。
func Verify(dir string) (CacheTrustReport, error) {
	rep := CacheTrustReport{Dir: dir}
	root, err := os.Lstat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return rep, nil // 还没建缓存：无可校验对象
	}
	if err != nil {
		return rep, fmt.Errorf("cachetrust: 校验缓存目录失败（无法 stat %s）: %w", dir, err)
	}
	if root.Mode()&os.ModeSymlink != 0 {
		rep.Violations = append(rep.Violations, CacheTrustViolation{Path: dir, Reason: "缓存根目录是符号链接（可被重定向到任意位置）"})
		return rep, nil
	}
	if !root.IsDir() {
		rep.Violations = append(rep.Violations, CacheTrustViolation{Path: dir, Reason: "缓存根路径不是目录"})
		return rep, nil
	}
	checkDir := func(p string, mode os.FileMode) {
		if mode&0o022 != 0 {
			rep.Violations = append(rep.Violations, CacheTrustViolation{Path: p,
				Reason: fmt.Sprintf("目录允许 group/other 写（mode=%#o）：同机其它用户可投毒", mode.Perm())})
		}
		if mode&0o400 == 0 {
			rep.Violations = append(rep.Violations, CacheTrustViolation{Path: p,
				Reason: fmt.Sprintf("目录属主不可读（mode=%#o）", mode.Perm())})
		}
	}
	checkDir(dir, root.Mode().Perm())

	// 只遍历两层（根 → wazero 版本分片目录 → 条目）：wazero 的缓存布局是固定的两层，
	// 更深的结构不属于它（若出现，说明有人在缓存目录里放了别的东西 —— 那本身就可疑）。
	shards, derr := os.ReadDir(dir)
	if derr != nil {
		return rep, fmt.Errorf("cachetrust: 读取缓存目录失败（%s）: %w", dir, derr)
	}
	for _, shard := range shards {
		shardPath := filepath.Join(dir, shard.Name())
		info, ierr := os.Lstat(shardPath)
		if ierr != nil {
			rep.Violations = append(rep.Violations, CacheTrustViolation{Path: shardPath, Reason: "无法 stat：" + ierr.Error()})
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			rep.Violations = append(rep.Violations, CacheTrustViolation{Path: shardPath, Reason: "缓存分片目录是符号链接"})
			continue
		}
		if info.IsDir() {
			checkDir(shardPath, info.Mode().Perm())
			entries, eerr := os.ReadDir(shardPath)
			if eerr != nil {
				rep.Violations = append(rep.Violations, CacheTrustViolation{Path: shardPath, Reason: "无法列出分片目录：" + eerr.Error()})
				continue
			}
			for _, entry := range entries {
				rep.Entries++
				rep.Violations = append(rep.Violations, verifyCacheEntryShape(filepath.Join(shardPath, entry.Name()))...)
			}
			continue
		}
		// 根下的非目录项：wazero 不会这样布局，但也不该直接判违规（可能是运维放的说明文件）；
		// 只按"条目"规则校验它的形状。
		rep.Entries++
		rep.Violations = append(rep.Violations, verifyCacheEntryShape(shardPath)...)
	}
	return rep, nil
}

// verifyCacheEntryShape 校验单个缓存条目的形状（普通文件、非空、无可写位、非符号链接）。
func verifyCacheEntryShape(path string) []CacheTrustViolation {
	info, err := os.Lstat(path)
	if err != nil {
		return []CacheTrustViolation{{Path: path, Reason: "无法 stat：" + err.Error()}}
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return []CacheTrustViolation{{Path: path, Reason: "缓存条目是符号链接（可把读条目变成读任意文件）"}}
	}
	if !info.Mode().IsRegular() {
		return []CacheTrustViolation{{Path: path, Reason: "缓存条目不是普通文件（FIFO/设备节点可造成阻塞或越权读）"}}
	}
	var out []CacheTrustViolation
	if info.Mode().Perm()&0o022 != 0 {
		out = append(out, CacheTrustViolation{Path: path,
			Reason: fmt.Sprintf("缓存条目允许 group/other 写（mode=%#o）：可被同机其它用户篡改", info.Mode().Perm())})
	}
	if info.Size() == 0 {
		out = append(out, CacheTrustViolation{Path: path, Reason: "缓存条目为空文件（半写/被截断）"})
	}
	return out
}

// Ensure 创建缓存目录（若不存在）、把权限纠正到 mode，并校验整棵树。
//
// 为什么必须显式 Chmod（2026-09-21 审计 F-4）：`os.MkdirAll(dir, 0700)` 只在**新建**时生效 ——
// 目录若已存在（旧版本创建、人工 chmod、更宽的 umask），权限会原样留着，
// 而"只有编译进程可写"这条缓解完全依赖它。同包的 appdb / upload 早就是
// "MkdirAll + 显式 Chmod" 的写法，缓存目录此前独缺。
//
// ⚠️ **校验必须先于任何改动权限的动作**（2026-09-21 独立审计 P1-①）：`os.Chmod` 会
// **跟随符号链接**，先 Chmod 再 Verify 等于"先按攻击者布置的链接改了目标目录的权限，
// 再去校验它"——`<dataRoot>/compile-cache` 被换成指向别处的链接时，
// 平台自己成了改权限的那只手。所以这里先用 `Lstat` 确认根路径是**真实目录**，
// 不是目录就一次权限位都不改、直接返回违规。
//
// 第二个坑（同一处）：`Chmod` 失败（非属主、只读挂载）原先**被当成成功** —— 调用方
// 拿到 err=nil 继续走，而权限其实没被纠正，日志里没有任何信号（审计复现：非属主下
// `Ensure` 返回 err=nil 且 `Trusted()==true`）。现在 Chmod 失败**原样返回错误**。
//
// 返回值：目录句柄层面的 err（无法创建/无法 chmod）与校验报告分开 —— 调用方对
// "校验发现违规"的策略不同（编译侧 require 档 fail-loud、执行侧降级告警），
// 但**两者都不该把"目录不可用"当成"目录可信"**。
func Ensure(dir string, mode os.FileMode) (CacheTrustReport, error) {
	// ① 先看根路径的真实形态：不存在 ⇒ 可以安全创建；存在但不是真实目录
	//（符号链接 / 普通文件 / 设备）⇒ 不碰权限，直接给违规报告。
	switch info, err := os.Lstat(dir); {
	case err == nil:
		if info.Mode()&os.ModeSymlink != 0 {
			return CacheTrustReport{Dir: dir, Violations: []CacheTrustViolation{{
				Path:   dir,
				Reason: "缓存根目录是符号链接（可被重定向到任意位置；平台不会跟随它改权限）",
			}}}, nil
		}
		if !info.IsDir() {
			return CacheTrustReport{Dir: dir, Violations: []CacheTrustViolation{{
				Path:   dir,
				Reason: "缓存根路径不是目录",
			}}}, nil
		}
	case errors.Is(err, fs.ErrNotExist):
		// 正常路径：下面创建。
	default:
		return CacheTrustReport{Dir: dir}, fmt.Errorf("cachetrust: 无法 stat 缓存目录 %s: %w", dir, err)
	}

	if err := os.MkdirAll(dir, mode); err != nil {
		return CacheTrustReport{Dir: dir}, fmt.Errorf("cachetrust: 创建缓存目录失败: %w", err)
	}
	// ② 创建与 Chmod 之间再确认一次（TOCTOU）：MkdirAll 对已存在路径不做事，
	// 所以必须重新 Lstat，否则上一步的结论可能已经过期。
	info, err := os.Lstat(dir)
	if err != nil {
		return CacheTrustReport{Dir: dir}, fmt.Errorf("cachetrust: 创建后无法 stat 缓存目录 %s: %w", dir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return CacheTrustReport{Dir: dir, Violations: []CacheTrustViolation{{
			Path:   dir,
			Reason: "缓存根目录在创建与授权之间被替换（非真实目录；平台不会跟随它改权限）",
		}}}, nil
	}
	if err := os.Chmod(dir, mode); err != nil {
		// 不吞错：调用方必须知道"权限没被纠正"（此前这里静默，日志显示一切正常）。
		return CacheTrustReport{Dir: dir}, fmt.Errorf(
			"cachetrust: 纠正缓存目录权限失败（%s → %#o）: %w", dir, mode.Perm(), err)
	}
	return Verify(dir)
}
