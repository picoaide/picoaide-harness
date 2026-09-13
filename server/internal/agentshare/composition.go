package agentshare

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/goccy/go-yaml"
	"github.com/goccy/go-yaml/ast"
	"github.com/goccy/go-yaml/parser"
)

// CompositionFile 是让一个目录成为智能体预设的编排文件(上游
// @deepseek-ai/dsh-agent-presets 的 COMPOSITION_FILE 常量)。
const CompositionFile = "agent.cordis.yml"

// ---------------------------------------------------------------------------
// 发布期编排闸门(archupd-1②)
//
// 背景:审核面(webadmin 预览)只内联 maxFilePreviewBytes(128KB)以内的
// 编排原文,超出即显示为空。此前上传路径只要求 agent.cordis.yml **存在**,
// 于是任何真实超过 128KB 的编排都能发布成功,而管理员在审核页只能看到
// 「—」——审核这一门形同虚设(伪造声明尺寸不是必要条件)。
//
// 技能侧的等价闸门是「ListArchiveContents 返回空 SKILL.md → skillmanifest.Parse
// 拒收」;智能体侧此前连这条都没有(composition 被 `_` 丢弃)。这里补上:
// 编排必须**可读**(非空且在上限内)且**可解析**(上游 loader 的入口列表
// 形状),否则发布期直接拒收,而不是留一个没人看过的包进入审核队列。
//
// F2-N1 / F2-N5 / F2-N8(2026-09-13 二轮修复):第一轮的「按字符统计解析预算」
// 有两个洞,这里按「解析前只扫结构 + 解析后按访问量计费」重做:
//
//  1. F2-N1:字符计数器看不见 YAML 别名展开。billion-laughs 形态只需 91 个
//     `&`/`*`、20 个括号、10 个 `- `(573 字节)就能让形状遍历按 9^k 指数展开
//     ——goccy 的别名是共享指针,堆内存不涨(连 OOM 都不触发),纯粹烧 CPU
//     (实测 n=8 时 29 秒且照样 201 入库)。现在形状遍历按**访问节点数**计费,
//     展开成本在这里被截断;group 嵌套另有深度上限,自引用别名也不会把栈吃穿。
//  2. F2-N5:计数器不分「YAML 结构」与「标量正文」,把块标量(大提示词)里的
//     markdown 项目符号/链接方括号当成插件行/流式集合,合法的大编排被误拒
//     (实测 59918 字节的合法编排被拒「插件行过多(- 共 2102 个)」)。现在解析
//     前的扫描器跳过块标量正文与引号内容,只统计真正的结构区。
//  3. F2-N8:闸门方言必须与上游 loader 一致。goccy 的 Unmarshal 只解第一份
//     文档,而上游 js-yaml 的 load 对多文档抛错 —— 多文档 `---` 此前被闸门
//     放行、被客户端拒收。现在用 Decoder 解第二份,存在即拒。前导 BOM 反向
//     对齐(上游接受、goccy 拒绝),解析前剥掉。
//
// N-1(2026-09-13 三轮修复):上面两层都只覆盖「**形状遍历**的成本」,而
// merge key(`<<:`)与深嵌套的成本落在**解析/解码器**里,于是两条新绕过:
//
//  1. merge key 炸弹:goccy 解码 `<<: [*a, *a, …]` 时做映射合并(逐键拷贝),
//     嵌套时按 fanout^k 爆炸;形状遍历只访问 name/group/config 三个键,合并
//     出来的键一个都不看(实测预算只扣掉 1 格),464 字节 → 12.4 秒、732 字节
//     → 131.7 秒,真 HTTP 201 入库。现在解析后**先**在 AST 上给 merge key
//     计数并估算合并展开量(线性,锚点带记忆化),超限即拒。
//  2. 引号状态机欠计数:普通标量里的撇号(`don't`)不是引号,而扫描器看到
//     任意 `'` 就进入「引号内」,把后续全部结构字符(含 `[`/`- `/`&*!`)判为
//     正文 —— 一个字符关掉全部解析前闸门(depth=40000 → 44 秒;流式集合里
//     同一行的撇号更是只有这一条判定能救,缩进复位够不着)。现在引号只在
//     **标量开头**(前一非空白字符是 : - , [ { ? 或行首)才开状态,跨行的
//     引号状态在缩进回落到同级/更浅时一并复位(符合 YAML 对标量续行的要求)。
//
// 边界说明(为什么不再给引号正文设字节上界):引号正文**不是结构**,跳过它
// 是正确行为而不是漏洞 —— 未闭合引号只会让 goccy 把一个巨大的字符串读进去
// (实测 100KB 未闭合引号 4–8ms 就报错),不会产生嵌套放大;而给正文设上限
// 会把合法的大引号提示词(现有回归测试里 42KB 的 `description: "…"`)误拒。
// 真正危险的「扫描器把结构当正文」已经由上面的标量开头判定+缩进复位封住,
// 剩下枚举不到的形态由第 3 层兜底。
//
// 但形态枚举永远追不上新的 YAML 构造(前两轮已两次被证伪),所以再加一层
// 与形态无关的兜底:**解析本身带墙钟预算**(decodeCompositionDocument 把
// AST 预解析 + merge 预算 + 解码整体放进带 deadline 的 goroutine),超时即
// 拒。前两层是快路径,这一层才是「未知的第三种形态」的防线。
// ---------------------------------------------------------------------------

const (
	// 结构区计数上限。它们是**结构**上限而非内容上限:上游自带的最大编排
	// 实测 34 个块序列指示符 / 18 个流式集合 / 0 个锚点。块标量与引号正文
	// 不计入(见 compositionStructureScanner),所以大提示词不会撞这些线。
	maxCompositionCollections = 2048 // 结构区 '[' ']' '{' '}' 出现次数
	maxCompositionIndicators  = 2048 // 结构区块序列指示符 "- " 出现次数
	maxCompositionReferences  = 4096 // 结构区 '&' '*' '!' 出现次数
	// 流式集合嵌套深度。与上游 js-yaml 的 maxDepth(100)同量级;goccy 的
	// 解析器对深嵌套会耗尽内存(进程级 fatal,不可 recover),必须在解析前挡。
	maxCompositionDepth = 64
	// 形状遍历的访问节点上限:别名在 goccy 里是共享指针,文本 <1KB 也能展开
	// 出 9^k 个节点,只有按**访问量**计费才真正封住 CPU(20 万次访问约 10ms,
	// 真实编排最大不过数千节点)。
	maxCompositionNodes = 200_000
	// group 行的嵌套深度上限(真实编排 1–2 层):自引用别名会让遍历无限递归,
	// 深度上限与节点预算一起把栈与 CPU 都封住。
	maxCompositionGroupDepth = 64

	// ---- N-1(三轮):解码期成本的闸门 ----

	// merge key(`<<:`)出现次数上限。它的合并成本不在形状遍历的计费面上,
	// 真实编排(上游 4 份 preset + 本仓全部夹具)实测 0 个,这里只留「确实要
	// 合并几个锚点」的余量。
	maxCompositionMergeKeys = 16
	// merge 展开后的「键拷贝量」上界(估算带记忆化,线性时间)。fanout^k 的
	// merge 炸弹在 k≥6 时就超过这个量;真实编排 0。
	maxCompositionMergeWork = 20_000
	// 单次「AST 预解析 + merge 预算 + 解码」的墙钟预算(默认值,见
	// compositionDecodeBudget)。128KB 以内的合法编排解析在毫秒级,2 秒是
	// 数十倍余量;超时说明遇到了未知的指数构造。
	compositionDecodeBudgetDefault = 2 * time.Second
	// 同时在飞的预算化解码上限:把「未知形态」的 CPU 占用限制在小常数,
	// 而不是让每个请求都开一个烧 CPU 的 goroutine。
	maxCompositionDecodeSlots = 8
	// 抢解码槽位的等待上限(抢不到就明确拒绝,不排队堆积)。
	compositionDecodeSlotWait = time.Second
	// 被「定罪」的文档(解析超预算)在备忘里保留多久:同一份文档的重试
	// 必须立即被拒,不能再对闸门重复计费。
	compositionCondemnedTTL = 10 * time.Minute
	// 定罪备忘的条数上限(只存 32 字节摘要,不存文档)。
	maxCompositionCondemned = 256
)

// compositionDecodeBudget 是单次解析的墙钟预算(测试可临时收紧以证明这条
// 闸门真的在跑;生产不修改)。
var compositionDecodeBudget = compositionDecodeBudgetDefault

// errCompositionTooLarge 表示形状遍历撞上节点预算(别名展开炸弹)。
var errCompositionTooLarge = errors.New("编排展开后的节点数超过上限(疑似别名递归展开),请精简编排")

// errCompositionMultiDocument 表示编排含多个 YAML 文档(上游 loader 拒收)。
var errCompositionMultiDocument = errors.New("composition contains more than one YAML document")

// errCompositionMergeBudget 表示 merge key(`<<:`)过多或合并展开量超限(N-1①)。
var errCompositionMergeBudget = errors.New("编排的 merge key(<<:)合并展开量超过上限")

// errCompositionDecodeSlow 表示解析超出了墙钟预算(N-1②,形态未知的指数构造)。
var errCompositionDecodeSlow = errors.New("编排解析耗时超过预算(疑似指数展开的 YAML 构造),已拒绝")

// errCompositionDecodeBusy 表示预算化解码槽位被占满(有在飞的慢文档)。
var errCompositionDecodeBusy = errors.New("编排校验繁忙,请稍后重试")

// ValidateAgentComposition 校验归档内 agent.cordis.yml 的内容:必须可读
// (非空且不超过预览上限)且可解析(顶层是插件行列表,每行是带 name 的映射,
// group 行的 config 再嵌一层列表——与上游 entryListSchema/entryListProblem
// 同口径)。返回的错误已是可以直接回给上传者的中文说明。
func ValidateAgentComposition(composition string) error {
	if strings.TrimSpace(composition) == "" {
		return fmt.Errorf("%s 读不出来(为空或超过 %dKB 预览上限):审核人看不到编排就不能发布,请精简后重试",
			CompositionFile, maxFilePreviewBytes>>10)
	}
	if len(composition) > maxFilePreviewBytes {
		return fmt.Errorf("%s 超过 %dKB 预览上限,审核面无法查看",
			CompositionFile, maxFilePreviewBytes>>10)
	}
	// 前导 UTF-8 BOM:上游 js-yaml 接受,作者也不会主动写 BOM —— 剥掉再解析,
	// 不能因为一个不可见字节把合法编排判死(方言对齐,F2-N8)。
	doc := strings.TrimPrefix(composition, "\ufeff")
	if err := checkCompositionBudget(doc); err != nil {
		return err
	}
	rows, err := decodeCompositionDocument(doc)
	if err != nil {
		switch {
		case errors.Is(err, errCompositionMultiDocument):
			return fmt.Errorf("%s 含多个 YAML 文档(---):上游加载器只接受单文档编排", CompositionFile)
		case errors.Is(err, errCompositionMergeBudget):
			return fmt.Errorf("%s %s(merge key 的映射合并在解码期逐键拷贝,是最容易被滥用的指数构造)", CompositionFile, err.Error())
		case errors.Is(err, errCompositionDecodeSlow):
			return fmt.Errorf("%s %s", CompositionFile, err.Error())
		case errors.Is(err, errCompositionDecodeBusy):
			return fmt.Errorf("%s %s", CompositionFile, err.Error())
		}
		return fmt.Errorf("%s 不是合法的 YAML:%s", CompositionFile, firstYAMLLine(err.Error()))
	}
	budget := compositionNodeBudget{left: maxCompositionNodes}
	if verr := compositionShapeProblem(rows, "", &budget, 0); verr != nil {
		if errors.Is(verr, errCompositionTooLarge) {
			return fmt.Errorf("%s %s", CompositionFile, verr.Error())
		}
		return fmt.Errorf("%s 不是可挂载的编排:%s", CompositionFile, verr)
	}
	return nil
}

// decodeCompositionDocument 解析**单文档** YAML,并且给解析本身加墙钟预算
// (N-1②)。预算放在这里而不是调用方,是因为「成本无界的外部调用」正是解析器
// 本身:任何「文本统计 → 预估解析成本」的方案都会被某种 YAML 构造证伪
// (R2 的 `&/*` 之后是 R3 的 `<<:`)。
//
// 三层结构:
//   - 快路径:checkCompositionBudget(解析前结构扫描,零成本挡已知形态);
//   - 确定性层:merge key 的 AST 预算(见 checkCompositionMergeBudget);
//   - 兜底层:整个「AST 预解析 + merge 预算 + 解码」跑在带 deadline 的
//     goroutine 里,超时即拒 —— 这一层覆盖枚举不到的第三种形态。
//
// 超时的文档记入「定罪」备忘:同一份文档的重试立即被拒,不能重复计费。
func decodeCompositionDocument(doc string) (any, error) {
	key := sha256.Sum256([]byte(doc))
	if compositionIsCondemned(key) {
		return nil, errCompositionDecodeSlow
	}
	select {
	case compositionDecodeGate <- struct{}{}:
	case <-time.After(compositionDecodeSlotWait):
		return nil, errCompositionDecodeBusy
	}
	type outcome struct {
		rows any
		err  error
	}
	// 缓冲 1:调用方超时离开后 goroutine 仍然写得进去,不会泄漏阻塞。
	done := make(chan outcome, 1)
	// 预算在启动 goroutine 之前读入局部变量:goroutine 不碰全局,测试临时
	// 收紧预算时不会与它产生数据竞争(-race 下也干净)。
	budget := compositionDecodeBudget
	go func() {
		defer func() { <-compositionDecodeGate }()
		rows, err := decodeCompositionDocumentBounded(doc)
		done <- outcome{rows: rows, err: err}
	}()
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case res := <-done:
		return res.rows, res.err
	case <-timer.C:
		condemnComposition(key)
		return nil, errCompositionDecodeSlow
	}
}

// decodeCompositionDocumentBounded 是预算内的解析主体:先做 merge 预算
// (只在文档里真的出现 `<<` 时付 AST 预解析的成本),再走原来的单文档解码。
func decodeCompositionDocumentBounded(doc string) (any, error) {
	// goccy 的扫描器要求 merge key 就是字面量 `<<`(后跟可选空白 + `:`),
	// 所以 `strings.Contains` 既充分又必要;真实编排(0 个 merge key)因此
	// 完全不付 AST 预解析的代价。
	if strings.Contains(doc, "<<") {
		file, err := parser.ParseBytes([]byte(doc), 0)
		if err != nil {
			return nil, err
		}
		if err := checkCompositionMergeBudget(file); err != nil {
			return nil, err
		}
	}
	return decodeCompositionDocumentRaw(doc)
}

// decodeCompositionDocumentRaw 解析**单文档** YAML。多文档必须拒绝:上游
// loader 用 js-yaml 的 load(单文档),对 `---` 分隔的多文档直接抛错;而
// goccy 的 Unmarshal 只解第一份、静默丢弃其余 —— 那会让闸门放行一份客户端
// 挂载不了的编排(F2-N8)。
func decodeCompositionDocumentRaw(doc string) (any, error) {
	dec := yaml.NewDecoder(strings.NewReader(doc))
	var rows any
	if err := dec.Decode(&rows); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("文档为空(只有注释或空白)")
		}
		return nil, err
	}
	var extra any
	switch err := dec.Decode(&extra); {
	case err == nil:
		return nil, errCompositionMultiDocument
	case errors.Is(err, io.EOF):
		return rows, nil
	default:
		return nil, err
	}
}

// ---------------------------------------------------------------------------
// N-1②:解码槽位 + 定罪备忘
// ---------------------------------------------------------------------------

var (
	// compositionDecodeGate 是预算化解码的并发闸门(容量 maxCompositionDecodeSlots)。
	compositionDecodeGate = make(chan struct{}, maxCompositionDecodeSlots)

	compositionCondemnedMu sync.Mutex
	// compositionCondemnedDocs 是「解析超预算」文档的摘要 → 定罪时间。
	compositionCondemnedDocs = map[[32]byte]time.Time{}
)

func compositionIsCondemned(key [32]byte) bool {
	compositionCondemnedMu.Lock()
	defer compositionCondemnedMu.Unlock()
	at, ok := compositionCondemnedDocs[key]
	if !ok {
		return false
	}
	if time.Since(at) > compositionCondemnedTTL {
		delete(compositionCondemnedDocs, key)
		return false
	}
	return true
}

func condemnComposition(key [32]byte) {
	compositionCondemnedMu.Lock()
	defer compositionCondemnedMu.Unlock()
	now := time.Now()
	for k, at := range compositionCondemnedDocs {
		if now.Sub(at) > compositionCondemnedTTL {
			delete(compositionCondemnedDocs, k)
		}
	}
	if len(compositionCondemnedDocs) >= maxCompositionCondemned {
		// 备忘满了:清掉最早的一半,保持有界(只存摘要,不存文档)。
		for k := range compositionCondemnedDocs {
			delete(compositionCondemnedDocs, k)
			if len(compositionCondemnedDocs) < maxCompositionCondemned/2 {
				break
			}
		}
	}
	compositionCondemnedDocs[key] = now
}

// ---------------------------------------------------------------------------
// N-1①:merge key 的 AST 预算
// ---------------------------------------------------------------------------

// checkCompositionMergeBudget 在**解码前**给 merge key 设两道限:
//  1. `<<` 的出现次数(maxCompositionMergeKeys):真实编排是 0;
//  2. 合并展开量估算(maxCompositionMergeWork):goccy 的 keyToNodeMap 对每个
//     merge 引用都要把被合并映射的键逐个拷贝出来,嵌套时按 fanout^k 爆炸。
//
// 估算在 AST 上做,每个节点只算一次(记忆化),所以本身是线性时间 —— 与
// 「先解析再估算」的次序配合,不会引入新的放大面。自引用/循环锚点直接判超限。
func checkCompositionMergeBudget(file *ast.File) error {
	if file == nil {
		return nil
	}
	st := &compositionMergeState{
		anchors:  map[string][]ast.Node{},
		costMemo: map[ast.Node]int{},
		keysMemo: map[ast.Node]int{},
		busy:     map[ast.Node]bool{},
	}
	st.collectAnchors(file)
	merges := 0
	st.walkMergeKeys(file, &merges)
	if merges > maxCompositionMergeKeys {
		return fmt.Errorf("%w(共 %d 个,上限 %d)", errCompositionMergeBudget, merges, maxCompositionMergeKeys)
	}
	if merges == 0 {
		return nil
	}
	total := 0
	for _, doc := range file.Docs {
		total = st.satAdd(total, st.cost(doc.Body))
		if st.overflow {
			break
		}
	}
	if st.overflow || total > maxCompositionMergeWork {
		return fmt.Errorf("%w(估算键拷贝量超过 %d)", errCompositionMergeBudget, maxCompositionMergeWork)
	}
	return nil
}

type compositionMergeState struct {
	anchors  map[string][]ast.Node
	costMemo map[ast.Node]int
	keysMemo map[ast.Node]int
	busy     map[ast.Node]bool
	overflow bool
}

// satAdd 饱和加法:估算值只需要「有没有超过上限」,不需要精确值,饱和可以
// 彻底避免 int 溢出,也让超大文档的估算保持常数时间。
func (st *compositionMergeState) satAdd(a, b int) int {
	const ceiling = maxCompositionMergeWork * 4
	if a >= ceiling || b >= ceiling || a+b >= ceiling {
		st.overflow = true
		if a < ceiling {
			a = ceiling
		}
		return a
	}
	return a + b
}

// collectAnchors 收集锚点名 → 节点(同名可多次定义,取值时取最大展开量,
// 避免与 goccy 的「后者覆盖前者」语义不一致时低估)。
func (st *compositionMergeState) collectAnchors(file *ast.File) {
	var visit func(ast.Node)
	visit = func(n ast.Node) {
		if n == nil {
			return
		}
		if a, ok := n.(*ast.AnchorNode); ok {
			if name := compositionAnchorName(a); name != "" {
				st.anchors[name] = append(st.anchors[name], a.Value)
			}
		}
		for _, c := range compositionChildNodes(n) {
			visit(c)
		}
	}
	for _, doc := range file.Docs {
		visit(doc)
	}
}

// walkMergeKeys 数一遍 `<<`(线性,不递归整个 AST,只数当前节点)。
func (st *compositionMergeState) walkMergeKeys(file *ast.File, merges *int) {
	var visit func(ast.Node)
	visit = func(n ast.Node) {
		if n == nil {
			return
		}
		if _, ok := n.(*ast.MergeKeyNode); ok {
			*merges++
		}
		for _, c := range compositionChildNodes(n) {
			visit(c)
		}
	}
	for _, doc := range file.Docs {
		visit(doc)
	}
}

// cost 估算「解码这个节点要访问多少个键/值」:merge 引用按引用点乘开,
// 其它节点每个只算一次(记忆化)。
func (st *compositionMergeState) cost(n ast.Node) int {
	if n == nil {
		return 0
	}
	if v, ok := st.costMemo[n]; ok {
		return v
	}
	if st.busy[n] { // 循环锚点:直接判超限,不做无限递归
		st.overflow = true
		return maxCompositionMergeWork * 4
	}
	st.busy[n] = true
	defer delete(st.busy, n)

	total := 0
	switch node := n.(type) {
	case *ast.MappingNode:
		for _, entry := range node.Values {
			total = st.satAdd(total, st.mappingEntryCost(entry))
		}
	case *ast.MappingValueNode:
		total = st.satAdd(total, st.mappingEntryCost(node))
	case *ast.MappingKeyNode:
		total = st.satAdd(total, st.cost(node.Value))
	case *ast.SequenceNode:
		for _, v := range node.Values {
			total = st.satAdd(total, st.cost(v))
		}
	case *ast.SequenceEntryNode:
		total = st.satAdd(total, st.cost(node.Value))
	case *ast.AnchorNode:
		total = st.satAdd(total, st.cost(node.Value))
	case *ast.TagNode:
		total = st.satAdd(total, st.cost(node.Value))
	case *ast.AliasNode:
		for _, ref := range st.resolveAlias(node) {
			total = st.satAdd(total, st.cost(ref))
		}
	case *ast.DirectiveNode:
		for _, v := range node.Values {
			total = st.satAdd(total, st.cost(v))
		}
	default:
		total = 1
	}
	st.costMemo[n] = total
	return total
}

// mappingEntryCost:普通条目 = 键 + 值各一次;merge 条目 = 被合并映射的
// **键数**(逐键拷贝)+ 该映射自身的解码成本 —— 每个引用点都要重算一次,
// 正是 fanout^k 的来源。
func (st *compositionMergeState) mappingEntryCost(entry *ast.MappingValueNode) int {
	if entry == nil {
		return 0
	}
	if entry.Key != nil && entry.Key.IsMergeKey() {
		return st.satAdd(st.cost(entry.Value), st.mergeKeys(entry.Value))
	}
	return st.satAdd(1, st.satAdd(st.cost(entry.Key), st.cost(entry.Value)))
}

// mergeKeys 估算「把这个 merge 值展开后并入父映射的键数」。
func (st *compositionMergeState) mergeKeys(n ast.Node) int {
	if n == nil {
		return 0
	}
	if v, ok := st.keysMemo[n]; ok {
		return v
	}
	if st.busy[n] {
		st.overflow = true
		return maxCompositionMergeWork * 4
	}
	st.busy[n] = true
	defer delete(st.busy, n)

	total := 0
	switch node := n.(type) {
	case *ast.MappingNode:
		for _, entry := range node.Values {
			if entry == nil {
				continue
			}
			if entry.Key != nil && entry.Key.IsMergeKey() {
				total = st.satAdd(total, st.mergeKeys(entry.Value))
			} else {
				total = st.satAdd(total, 1)
			}
		}
	case *ast.AnchorNode:
		total = st.mergeKeys(node.Value)
	case *ast.TagNode:
		total = st.mergeKeys(node.Value)
	case *ast.AliasNode:
		for _, ref := range st.resolveAlias(node) {
			total = st.satAdd(total, st.mergeKeys(ref))
		}
	case *ast.SequenceNode:
		for _, v := range node.Values {
			total = st.satAdd(total, st.mergeKeys(v))
		}
	case *ast.SequenceEntryNode:
		total = st.mergeKeys(node.Value)
	}
	st.keysMemo[n] = total
	return total
}

func (st *compositionMergeState) resolveAlias(n *ast.AliasNode) []ast.Node {
	if n == nil || n.Value == nil {
		return nil
	}
	return st.anchors[n.Value.GetToken().Value]
}

// compositionAnchorName 取锚点名(锚点节点里 Name 是字符串标量)。
func compositionAnchorName(n *ast.AnchorNode) string {
	if n == nil || n.Name == nil {
		return ""
	}
	if s, ok := n.Name.(*ast.StringNode); ok {
		return s.Value
	}
	return n.Name.GetToken().Value
}

// compositionChildNodes 枚举一个 AST 节点的直接子节点(只覆盖解析器会产出的
// 节点类型;未列出的类型按叶子处理,不影响 merge 计数的**上界**性质)。
func compositionChildNodes(n ast.Node) []ast.Node {
	switch node := n.(type) {
	case *ast.DocumentNode:
		return []ast.Node{node.Body}
	case *ast.MappingNode:
		out := make([]ast.Node, 0, len(node.Values))
		for _, v := range node.Values {
			out = append(out, v)
		}
		return out
	case *ast.MappingValueNode:
		return []ast.Node{node.Key, node.Value}
	case *ast.MappingKeyNode:
		return []ast.Node{node.Value}
	case *ast.SequenceNode:
		return node.Values
	case *ast.SequenceEntryNode:
		return []ast.Node{node.Value}
	case *ast.AnchorNode:
		return []ast.Node{node.Value}
	case *ast.AliasNode:
		return []ast.Node{node.Value}
	case *ast.TagNode:
		return []ast.Node{node.Value}
	case *ast.DirectiveNode:
		return node.Values
	}
	return nil
}

// compositionNodeBudget 是形状遍历的访问预算。别名炸弹的**文本**很小,
// 但展开后的树按 9^k 增长;每次访问扣一格,预算耗尽即拒(F2-N1)。
type compositionNodeBudget struct{ left int }

func (b *compositionNodeBudget) visit() error {
	if b.left <= 0 {
		return errCompositionTooLarge
	}
	b.left--
	return nil
}

// compositionShapeProblem 复刻上游 entryListProblem 的形状校验:顶层列表、
// 每行是映射且有非空 name、group 行的 config 是同样的列表。遍历同时扣减
// 节点预算并限制 group 嵌套深度,因此别名展开 / 自引用别名都不会失控。
func compositionShapeProblem(rows any, at string, budget *compositionNodeBudget, depth int) error {
	list, ok := rows.([]any)
	if !ok {
		if at == "" {
			return errors.New("顶层必须是插件行列表(agent.cordis.yml 由若干 `- id/name` 行组成)")
		}
		return fmt.Errorf("%s 必须是插件行列表", at)
	}
	for i, raw := range list {
		if err := budget.visit(); err != nil {
			return err
		}
		label := fmt.Sprintf("第 %d 行", i+1)
		if at != "" {
			label = at + " " + label
		}
		row, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("%s不是插件行(需要含 name 的映射)", label)
		}
		if name, _ := row["name"].(string); strings.TrimSpace(name) == "" {
			return fmt.Errorf("%s缺少 name(插件包名)", label)
		}
		if g, _ := row["group"].(bool); g {
			if depth+1 > maxCompositionGroupDepth {
				return fmt.Errorf("%s 的 group 嵌套过深(上限 %d 层,疑似自引用别名)", label, maxCompositionGroupDepth)
			}
			if err := compositionShapeProblem(row["config"], label, budget, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkCompositionBudget 在交给 YAML 解析器之前,只统计**结构区**的复杂度:
// 流式集合嵌套深度/数量、块序列指示符、锚点/别名/标签。它挡的是纯结构炸弹
// (`[`×65536、6000 个 `- `)以及 goccy 解析器的深嵌套 OOM;别名展开的 CPU
// 由解析后的节点预算负责(F2-N1),块标量/引号正文完全不参与统计(F2-N5)。
func checkCompositionBudget(raw string) error {
	sc := compositionStructureScanner{}
	for i := 0; i < len(raw); {
		lineStart := i
		j := i
		for j < len(raw) && (raw[j] == ' ' || raw[j] == '\t') {
			j++
		}
		indent := j - lineStart
		if j >= len(raw) || raw[j] == '\n' {
			i = skipCompositionLine(raw, j)
			continue
		}
		// 块标量正文:缩进深于头部行 → 整体是内容,不是结构。
		if sc.inBlock {
			if indent > sc.blockIndent {
				i = skipCompositionLine(raw, j)
				continue
			}
			sc.inBlock = false
		}
		// 引号标量的续行必须缩进更深(N-1②):回到同级或更浅的缩进,说明这个
		// 标量已经结束(或本来就没闭合)—— 恢复结构计数,别让一个未闭合的引号
		// 把后续全部内容变成「引号内」,等于关掉闸门。
		if sc.quote != 0 && indent <= sc.quoteIndent {
			sc.quote = 0
		}
		if sc.quote == 0 && raw[j] == '#' {
			i = skipCompositionLine(raw, j) // 整行注释
			continue
		}
		k := j
		for k < len(raw) && raw[k] != '\n' {
			c := raw[k]
			if sc.quote == '\'' {
				if c == '\'' {
					if k+1 < len(raw) && raw[k+1] == '\'' {
						k += 2 // '' 是转义的单引号
						continue
					}
					sc.quote = 0
				}
				k++
				continue
			}
			if sc.quote == '"' {
				if c == '\\' {
					k += 2 // 转义序列
					continue
				}
				if c == '"' {
					sc.quote = 0
				}
				k++
				continue
			}
			switch c {
			case '\'', '"':
				// N-1②:只有位于**标量开头**的引号才开启引号状态。YAML 的
				// 普通标量里可以出现任意引号(`it's`、`he said "hi"`),把它们
				// 当成引号状态机会让后续全部结构字符不计数(欠计数 = 一个字符
				// 关掉全部解析前闸门)。
				if compositionQuoteOpener(raw, k, lineStart) {
					sc.quote = c
					sc.quoteIndent = indent
				}
			case '#':
				if k == lineStart || raw[k-1] == ' ' || raw[k-1] == '\t' {
					k = skipCompositionLine(raw, k) // 注释:本行剩余部分不是结构
					continue
				}
			case '[', '{':
				sc.collections++
				sc.depth++
				if sc.depth > sc.maxDepth {
					sc.maxDepth = sc.depth
				}
			case ']', '}':
				sc.collections++
				if sc.depth > 0 {
					sc.depth--
				}
			case '&', '*', '!':
				sc.references++
			case '-':
				if k+1 >= len(raw) || raw[k+1] == ' ' || raw[k+1] == '\t' || raw[k+1] == '\n' {
					sc.indicators++
				}
			case '|', '>':
				if ok := blockScalarHeader(raw, k, lineStart); ok {
					sc.inBlock, sc.blockIndent = true, indent
					k = skipCompositionLine(raw, k)
					continue
				}
			}
			k++
		}
		i = skipCompositionLine(raw, j)
	}
	switch {
	case sc.maxDepth > maxCompositionDepth:
		return fmt.Errorf("%s 的 YAML 嵌套过深(深度 %d,上限 %d)", CompositionFile, sc.maxDepth, maxCompositionDepth)
	case sc.collections > maxCompositionCollections:
		return fmt.Errorf("%s 的流式集合过多([ { ] } 共 %d 个,上限 %d)", CompositionFile, sc.collections, maxCompositionCollections)
	case sc.indicators > maxCompositionIndicators:
		return fmt.Errorf("%s 的插件行过多(- 共 %d 个,上限 %d)", CompositionFile, sc.indicators, maxCompositionIndicators)
	case sc.references > maxCompositionReferences:
		return fmt.Errorf("%s 的锚点/别名/标签过多(& * ! 共 %d 个,上限 %d)", CompositionFile, sc.references, maxCompositionReferences)
	}
	return nil
}

// compositionStructureScanner 是解析前扫描器的状态:流式深度跨行累计(多行
// 嵌套 `[` 同样会撑爆解析器),引号与块标量状态跨行保持(YAML 的引号标量可以
// 换行)。
type compositionStructureScanner struct {
	collections int
	indicators  int
	references  int
	depth       int
	maxDepth    int
	quote       byte // 0 = 不在引号里,'\'' / '"' = 引号类型
	inBlock     bool // 正在跳过块标量正文
	blockIndent int  // 块标量头部所在行的缩进
	quoteIndent int  // 引号标量开始那行的缩进(续行必须更深)
}

// compositionQuoteOpener 判断 raw[at] 的引号是否开启了**引号标量**(N-1②)。
// 判据是「引号位于标量开头」:向前跳过空白后,前一字符是 : , [ { ? 或 `-`
// (块序列项,且它自己也在行首)之一;或者引号就是本行缩进后的第一个字符。
// 口径与 blockScalarHeader 一致(同样只认「标量起始」的指示符)。
func compositionQuoteOpener(raw string, at, lineStart int) bool {
	p := at - 1
	for p >= lineStart && (raw[p] == ' ' || raw[p] == '\t') {
		p--
	}
	if p < lineStart {
		return true // 行首(缩进后第一个非空白字符)
	}
	switch raw[p] {
	case ':', ',', '[', '{', '?':
		return true
	case '-':
		// `- 'x'`(块序列项)才算标量开头;`a-'b` 里的 '-' 是普通字符。
		q := p - 1
		for q >= lineStart && (raw[q] == ' ' || raw[q] == '\t') {
			q--
		}
		return q < lineStart
	}
	return false
}

// blockScalarHeader 判断 raw[at]('|' 或 '>')是不是块标量头部:前一个非空白
// 字符必须是 ':' 或 '-',且指示符之后只允许出现缩进指示数字/裁剪修饰符
// (±)/空白/注释。`x: a > b` 这类普通标量里的 '>' 不会被误判。
func blockScalarHeader(raw string, at, lineStart int) bool {
	p := at - 1
	for p >= lineStart && (raw[p] == ' ' || raw[p] == '\t') {
		p--
	}
	if p >= lineStart && raw[p] != ':' && raw[p] != '-' {
		return false
	}
	q := at + 1
	for q < len(raw) {
		c := raw[q]
		if c == '\n' || c == '#' || c == ' ' || c == '\t' || c == '+' || c == '-' || (c >= '0' && c <= '9') {
			break
		}
		return false
	}
	return true
}

// skipCompositionLine 返回 from 所在行之后的位置(含行尾换行符)。
func skipCompositionLine(raw string, from int) int {
	if i := strings.IndexByte(raw[from:], '\n'); i >= 0 {
		return from + i + 1
	}
	return len(raw)
}

// firstYAMLLine 只保留解析错误的第一行(多行 code-frame 不适合回给用户)。
func firstYAMLLine(msg string) string {
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		return msg[:i]
	}
	return msg
}
