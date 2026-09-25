package main

// R16C-06（审计 2026-09-25，P2）的**静态判据**：文档点名"可调"的旋钮在 compose 部署里
// 必须真的够得到。
//
// 缺陷形态：`PICOAI_GATEWAY_MAX_INFLIGHT_PER_USER`（`docs/deploy/AI-DEPLOY.md` §网关、
// `server/docs/04-auth.md` 都写"可调"）与 `PICOAI_LDAP_ALLOW_PLAINTEXT`（v2.7.3 发布
// 说明与安全审计文档写"需要时设 =1"）**都不在 `server/docker-compose.yml` 的
// `server.environment` 映射里**，compose 也没有 `env_file` ⇒ 运维按文档把键写进 `.env`
// 后重启，**静默不生效、零回显**（实测 `docker compose config` 解析结果里没有它们）。
//
// 两个方向的判据：
//  1. 具名（TestComposeWiresNamedGatewayKnobs）：那两个键必须出现在解析出的
//     server.environment 里 —— 这是本次审计点名的修复对象；
//  2. 通用（TestEveryServerPICOAIEnvNameIsWiredOrExempt）：服务端源码里出现的**每个**
//     `PICOAI_*` 名字都必须"已接线"或"在豁免清单里且写明理由"。没有这一条，下一个
//     `PICOAI_*` 旋钮会以完全相同的方式再漏一次（本轮就是四个同族键一起漏的）。
//
// 判据读的是**文件本身**（compose 的 environment 映射），不跑 docker：CI 的 Go job
// 里没有 docker compose，而"映射里有没有这个键"是纯文本事实。`docker compose config`
// 的解析结果在探针里人工核对过（temp/r16/V/evidence/{before,after}-compose.txt）。

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/goccy/go-yaml"
)

// composePath 是部署编排文件（本测试的工作目录是 server/cmd/server）。
const composePath = "../../docker-compose.yml"

// composeServerEnvironment 解析 docker-compose.yml，返回 services.server.environment
// 的**键集合**。缺服务/缺 environment 直接 Fatal —— 判据锚点漂移必须响亮地失败，
// 而不是"没找到键 ⇒ 空集合 ⇒ 判据变成恒真"。
func composeServerEnvironment(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("读 %s: %v", composePath, err)
	}
	// 用 map 形态而不是嵌套匿名结构体：goccy/go-yaml 对"嵌套匿名结构体 + 标签"的
	// 支持与 map 形态不一致（实测结构体形态解析出空映射），而判据的取向是
	// "读到的必须是文件里真实的那段映射" —— 用最不容易悄悄退化的形态。
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("解析 %s: %v", composePath, err)
	}
	services, ok := doc["services"].(map[string]any)
	if !ok {
		t.Fatalf("%s 里没有 services 映射（判据锚点漂移）", composePath)
	}
	server, ok := services["server"].(map[string]any)
	if !ok {
		t.Fatalf("%s 里没有 services.server（判据锚点漂移）", composePath)
	}
	rawEnv, ok := server["environment"].(map[string]any)
	if !ok {
		t.Fatalf("%s 的 services.server.environment 不是映射（判据锚点漂移：整段映射被搬走/改名了）", composePath)
	}
	env := make(map[string]string, len(rawEnv))
	for k, v := range rawEnv {
		env[k] = fmt.Sprintf("%v", v)
	}
	if len(env) == 0 {
		t.Fatalf("%s 的 services.server.environment 解析为空（判据锚点漂移）", composePath)
	}
	return env
}

// TestComposeWiresNamedGatewayKnobs 是 R16C-06 的具名判据。
func TestComposeWiresNamedGatewayKnobs(t *testing.T) {
	env := composeServerEnvironment(t)
	// 两个键就是审计点名的对象：它们的文档口径是"可调"，而修前写进 .env 完全无效。
	want := []string{
		"PICOAI_GATEWAY_MAX_INFLIGHT_PER_USER",
		"PICOAI_LDAP_ALLOW_PLAINTEXT",
	}
	for _, k := range want {
		if _, ok := env[k]; !ok {
			t.Errorf("%s 不在 server.environment 里 —— 文档说它可调，写进 .env 却静默不生效"+
				"（要么接线 ${%s:-}，要么删掉文档里的'可调'口径）", k, k)
		}
	}
	// 反向自证：接线必须是"透传默认值"的形状，而不是把值**写死**在 compose 里
	// （写死会让 .env 里的取值继续被无视 —— 症状一样，只是换了个地方）。
	for _, k := range want {
		if v, ok := env[k]; ok && !strings.Contains(v, "${"+k) {
			t.Errorf("%s 的取值是 %q —— 必须写成 ${%s:-} 才能让 .env 生效（写死等于换一种方式无视运维配置）", k, v, k)
		}
	}
}

// picoaiEnvExemptions 是**故意不接进 compose** 的 PICOAI_* 名字，每条必须写明理由。
//
// 判据的取向是"服务端源码提到的每个 PICOAI_* 名字都要有归宿"：接线（compose 里能看见）
// 或豁免（这里能看见理由）。两边都没有 = 又一个"文档/代码里有、部署里够不到"的旋钮。
var picoaiEnvExemptions = map[string]string{
	// 镜像内路径：由 Dockerfile 的 ENV 提供（不是运维旋钮）。
	"PICOAI_CHANNEL_DIR":        "镜像内渠道内容目录（Dockerfile ENV PICOAI_CHANNEL_DIR）",
	"PICOAI_CLIENT_RELEASE_DIR": "镜像内客户端安装包目录（Dockerfile ENV PICOAI_CLIENT_RELEASE_DIR）",
	"PICOAI_CHANNEL_FILE":       "镜像内渠道声明文件路径（Dockerfile 落盘，见 updatecheck）",
	"PICOAI_DEMO_APPS_DIR":      "镜像内内置演示应用目录（Dockerfile 打进 /opt/picoaide/demo-apps）",
	// 编译子进程内部参数：由 verify/compile 的实参传递，父进程环境里的同名值**不被读取**
	// （见 internal/wasmapp/compile/env.go 的注释），所以它不是部署旋钮。
	"PICOAI_COMPILE_MEMORY_PAGES": "编译子进程的内存上限（由父进程以实参注入，父环境同名值不生效）",
	// 已废除：写进 .env 会被启动自检大声告警并给出清理命令（cmd/server/legacy_config.go）。
	// 故意不接线 —— 接线等于给废除开关续命。
	"PICOAI_APPS_BASE_DOMAIN":         "已废除（legacy_config.go 告警 + 清理命令）",
	"PICOAI_TRUSTED_PROXIES_EXPLICIT": "已废除（legacy_config.go 告警 + 清理命令）",
}

// picoaiEnvLiteral 匹配 Go 源码里的 PICOAI_* 名字字面量（含 const 声明 ——
// 经由常量的读取同样是一句"这个键存在"，判据不该因为写法不同而漏掉）。
var picoaiEnvLiteral = regexp.MustCompile(`"PICOAI_[A-Z0-9_]+"`)

// TestEveryServerPICOAIEnvNameIsWiredOrExempt 是 R16C-06 的通用判据：
// 服务端源码里提到的每个 PICOAI_* 名字，要么在 compose 的 server.environment 里，
// 要么在豁免清单里（带理由）。
func TestEveryServerPICOAIEnvNameIsWiredOrExempt(t *testing.T) {
	env := composeServerEnvironment(t)

	roots := []string{filepath.Join("..", "..", "internal"), filepath.Join("..", "..", "cmd")}
	seen := map[string]string{} // 名字 -> 首个出现的相对路径（报错时指路）
	for _, root := range roots {
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				// 跳过生成物/依赖目录；vendor 里不会有我们的 env 名。
				if base := info.Name(); base == "webadmin" || base == "node_modules" || base == "testdata" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			raw, rerr := os.ReadFile(path)
			if rerr != nil {
				return rerr
			}
			for _, m := range picoaiEnvLiteral.FindAllString(string(raw), -1) {
				name := strings.Trim(m, `"`)
				if _, ok := seen[name]; !ok {
					seen[name] = path
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("遍历 %s: %v", root, err)
		}
	}
	if len(seen) < 10 {
		t.Fatalf("只扫到 %d 个 PICOAI_* 名字（判据锚点漂移：源码扫描没生效）", len(seen))
	}

	var unwired []string
	for name, where := range seen {
		if _, ok := env[name]; ok {
			continue
		}
		if _, ok := picoaiEnvExemptions[name]; ok {
			continue
		}
		unwired = append(unwired, name+" ("+where+")")
	}
	sort.Strings(unwired)
	if len(unwired) > 0 {
		t.Errorf("这些 PICOAI_* 名字既不在 %s 的 server.environment 里、也没有豁免理由："+
			"写进 .env 会静默不生效（接线写成 `PICOAI_X: ${PICOAI_X:-}`，或在 picoaiEnvExemptions 里写明为什么它不是部署旋钮）:\n  %s",
			composePath, strings.Join(unwired, "\n  "))
	}

	// 反向守卫：豁免清单不得**陈旧**（一个已经接线的键留在豁免里 = 下一次漏接线的温床）。
	for name := range picoaiEnvExemptions {
		if _, wired := env[name]; wired {
			t.Errorf("%s 已经接线，但仍留在豁免清单里 —— 请从 picoaiEnvExemptions 删掉", name)
		}
	}
	// 豁免清单里的名字也必须真的还在源码里出现（否则是死条目）。
	for name := range picoaiEnvExemptions {
		if _, ok := seen[name]; !ok {
			t.Errorf("豁免清单里的 %s 在服务端源码里已经不存在 —— 请删掉这条死豁免", name)
		}
	}
}
