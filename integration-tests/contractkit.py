#!/usr/bin/env python3
"""`integration-tests` 的**契约判据通道**:判据求值 + 失败计数 + 自检(两个 `.py` 与门禁共用一份)。

## 为什么单独成文件(2026-09-23 第十三轮审计 F-01,P0)

第 4–6 轮把「判据表 + 每条判据正/负例 + 运行期逐条引用 + 端到端变异」这套纪律**只加在
`electron-shots` 一条腿**上(`scripts/check-integration-tests.mjs` 的 1c-2 / 1c-3 / 1c-4 段)。
另两条腿(`dex-sso-test.py` / `ldap-rbac-brand-test.py`)停在「`--self-test` 夹具数 ≥ 15 +
3 条假网关负例」,于是:

    dex 掏空运行期判据: 6 / ldap 掏空运行期判据: 8
    self-test: 24/24 条判据夹具符合预期   ← 夹具层完全看不出掏空
    self-test: 29/29 条判据夹具符合预期
    check-integration-tests: OK — … 2 个契约脚本判据自检通过 …     REAL_GATE_EXIT=0

根因不是"少写了几条断言",而是**判据本体与运行期调用点在同一个可变文件里**:
`check(name, [], '')` 一句就把一条判据变成恒真,而没有任何一层会去问"这条判据真的还在判吗"。

## 处置(与 `electron-shots/assertions.mjs` + `report.mjs` 同形,三层缺一不可)

1. **判据本体外置**到各脚本的 `CRITERIA` 表(单一真源),运行期只按 **id** 求值;
2. **每条判据配正例 + 负例夹具**(`SELF_TEST_FIXTURES`),`--self-test` 逐条跑
   ⇒ 把任何一条判据的 `evaluate` 掏成 `return []` 都会让它的负例夹具失败、当场红;
3. **判定通道与计数下沉到本文件**,运行期脚本只接线;`--self-check` 把**全部夹具**
   经**运行期那条 `report()`** 求值 ⇒ 掏空 `judge()`、只改计票侧、或把通道换成恒真包装,
   都会在这里产出与期望不符的结论。

`scripts/check-integration-tests.mjs` 会跑这三个入口,并在**变异副本**上复跑要求变红。

## 用法(供门禁与人工)

| 入口 | 作用 |
|---|---|
| `<脚本> --self-test`  | 判据本体自证:每条判据的正/负例夹具必须给出期望结论 |
| `<脚本> --self-check` | 判定通道自证:全部夹具经运行期 `report()` 求值 |
| `<脚本> --dump-criteria` | 打印判据表 JSON(`id` / 名称 / 正负例条数),供门禁做登记值对账 |

退出码:0 = 通过;1 = 有夹具/判据不符合预期;2 = 用法错误。
`CriteriaError` = 判据表或返回值**形状**不合法 —— 一律 fail-loud:静默通过是恒真判据的
另一种写法,不能靠"宽容"绕过去。
"""

EXIT_PASS, EXIT_FAIL, EXIT_USAGE, EXIT_SKIP = 0, 1, 2, 77

_VERDICT_OK = '✓'
_VERDICT_FAIL = '✗'


class CriteriaError(RuntimeError):
    """判据表 / 求值结果的形状错误(必须 fail-loud,不得静默当成通过)。"""


def criteria_by_id(criteria):
    """把判据列表建成 id → 判据 的索引,并校验表本身的形状。

    :param criteria: `[{'id', 'name', 'evaluate'}, …]`。
    :returns: 索引 dict(重复 id / 缺字段 / evaluate 不可调用 ⇒ 抛 `CriteriaError`)。
    """
    index = {}
    for item in criteria:
        if not isinstance(item, dict):
            raise CriteriaError(f'判据必须是 dict,实得 {type(item).__name__}')
        criterion_id = item.get('id')
        if not isinstance(criterion_id, str) or criterion_id == '':
            raise CriteriaError(f'判据缺 id:{item!r}')
        if criterion_id in index:
            raise CriteriaError(f'判据 id 重复:{criterion_id!r}(id 是判定与登记的键,不允许重名)')
        if not callable(item.get('evaluate')):
            raise CriteriaError(f'判据 {criterion_id} 的 evaluate 必须是可调用对象')
        index[criterion_id] = item
    return index


def observation_of(observation, criterion_id):
    """取观测:形状校验 + 判据 id 一致性检查(每条 `evaluate` 的第一句)。

    它同时是**端到端变异的注入锚点**:`scripts/check-integration-tests.mjs` 在每条判据
    的 `evaluate` 首句后面插一句 `return []` 来构造"判据被掏成恒真"的副本
    —— 锚点消失时那条变异会**报错而不是静默跳过**(见守卫里的 `criteria-tautology`)。

    :param observation: 运行期现场采集的观测(必须是 dict)。
    :param criterion_id: 调用方声明的判据 id(仅用于报错信息,便于定位)。
    :returns: 原样返回 `observation`。
    """
    if not isinstance(observation, dict):
        raise CriteriaError(
            f'判据 {criterion_id} 的观测必须是 dict,实得 {type(observation).__name__}'
            ' —— 观测缺失/形状不对时判失败,不能当成通过("观测是 undefined 就放过"正是恒真判据的另一种写法)',
        )
    return observation


def judge(criteria, criterion_id, observation):
    """**唯一判定入口**:按 id 取判据 → 求值 → 形状校验 → 结论。

    三条硬约束(与 `electron-shots/report.mjs` 的 `judge()` 同形):
      ① 未知 id **当场抛错**(id 打错必须炸,不能静默少判一条);
      ② `evaluate()` 必须返回字符串列表(`problems`,空 = 通过);返回别的形状**抛错**
         —— "形状不合法就当通过"是恒真判据的另一种写法;
      ③ 本层只做形状校验,不追加任何自己的判断。

    :param criteria: 判据表(见 `criteria_by_id`)。
    :param criterion_id: 判据 id。
    :param observation: 现场观测。
    :returns: `{'id', 'name', 'ok', 'problems'}`。
    """
    index = criteria_by_id(criteria)
    if criterion_id not in index:
        raise CriteriaError(
            f'未知判据 id:{criterion_id!r}(判据表里没有它)'
            ' —— 运行期引用了表外的 id 必须当场炸,否则就是"表里写了但没判"',
        )
    item = index[criterion_id]
    problems = item['evaluate'](observation)
    if not isinstance(problems, list):
        raise CriteriaError(
            f'判据 {criterion_id} 的 evaluate() 必须返回 problems 列表,实得 {type(problems).__name__}'
            ' —— 形状不合法的返回值不得被当成结论',
        )
    for problem in problems:
        if not isinstance(problem, str):
            raise CriteriaError(f'判据 {criterion_id} 的 problems 里必须全是字符串,实得 {problem!r}')
    return {
        'id': criterion_id,
        'name': str(item.get('name') or criterion_id),
        'ok': not problems,
        'problems': list(problems),
    }


class Reporter:
    """判定通道实例:持有失败计数、逐条结论、以及**真的打出去的结论行**。

    运行期脚本必须**持有本类的实例并直接调 `reporter.report(...)`**(不允许自己再包一层
    同名函数):那层包装就是"运行期结论可被一句替换掉"的逃逸点(`--self-check` 消费的是
    运行期自己那份绑定,包装被换成恒真时它会当场变红)。

    :param criteria: 判据表。
    :param write: 输出函数(默认 `print`);自检时可换成收集器。
    """

    def __init__(self, criteria, write=None):
        self._criteria = criteria
        self._write = write if write is not None else print
        self._failures = 0
        self._events = []
        self._lines = []

    def _emit(self, line):
        self._lines.append(line)
        self._write(line)

    def report(self, criterion_id, observation):
        """判一条、把结论打出去,并只在**判定为不通过**时递增失败计数。

        :returns: 该条是否通过(透传判据结论)。
        """
        verdict = judge(self._criteria, criterion_id, observation)
        problems = verdict['problems']
        # 结论行 = 判据名 + 首条问题(与旧脚本 `check(name, problems, detail)` 的输出形态一致,
        # 便于既有排障习惯与假网关场景的正则断言继续成立)。
        first = problems[0] if problems else ''
        self._emit(f'{_VERDICT_OK if verdict["ok"] else _VERDICT_FAIL} {verdict["name"]}'
                   f'{("  " + first) if first else ""}')
        # 其余问题逐条另起一行**仅供人读**,不计入结论行(结论行必须一条判据恰好一行,
        # 否则"判定通道打了几条"就无法与夹具条数对账)。
        for problem in problems[1:]:
            self._write(f'    - {problem}')
        self._events.append({'id': criterion_id, 'ok': verdict['ok']})
        if not verdict['ok']:
            self._failures += 1
        return verdict['ok']

    def failures(self):
        """已记录的失败条数(运行期脚本不再自己维护这个计数)。"""
        return self._failures

    def events(self):
        """逐条结论(自检/排障用)。"""
        return list(self._events)

    def lines(self):
        """本通道真的打出去的**结论行**(一条判据恰好一行;自检沿它核对"每条都打了")。"""
        return list(self._lines)

    def exit_code(self):
        """进程退出码:有失败即 1(与两个脚本的 EXIT_FAIL 同值)。"""
        return EXIT_FAIL if self._failures > 0 else EXIT_PASS


def run_criteria_self_test(criteria, fixtures):
    """判据本体自证:**每条判据都必须有正例与负例**,且每条夹具都给出期望结论。

    负例不被拒 = 判据退化成恒真(或恒假)—— 这正是把 `check(name, [], '')` 那一句写出来
    之后没人发现的原因。夹具直接走 `evaluate()`(**判据本体**那一层);
    "运行期那条通道真的在透传结论"由 `run_reporter_self_check()` 另外证。

    :returns: `{'failures', 'total', 'passed'}`;`failures` 是给人看的消息列表。
    """
    index = criteria_by_id(criteria)
    failures = []
    for item in criteria:
        cases = [fixture for fixture in fixtures if fixture.get('id') == item['id']]
        if not any(fixture.get('expect') is True for fixture in cases):
            failures.append(f'判据 {item["id"]} 没有**正例**夹具(恒假的判据同样没有判别力)')
        if not any(fixture.get('expect') is False for fixture in cases):
            failures.append(f'判据 {item["id"]} 没有**负例**夹具(被掏空成恒真的判据在这里不会被发现)')
    for fixture in fixtures:
        fixture_id = fixture.get('id')
        if fixture_id not in index:
            failures.append(f'夹具 {fixture_id!r} 指向不存在的判据')
            continue
        if fixture.get('expect') not in (True, False):
            failures.append(f'夹具 {fixture_id} 的 expect 必须是 True/False,实得 {fixture.get("expect")!r}')
            continue
        if not isinstance(fixture.get('observation'), dict):
            failures.append(f'夹具 {fixture_id} 必须给 observation(dict)')
            continue
        problems = index[fixture_id]['evaluate'](fixture['observation'])
        if not isinstance(problems, list):
            failures.append(f'{fixture_id}: evaluate() 返回 {type(problems).__name__},必须是 problems 列表')
            continue
        ok = not problems
        if ok != fixture['expect']:
            failures.append(
                f'{fixture_id}: 期望 ok={fixture["expect"]},实得 {ok}({fixture.get("why", "")})'
                + (f' problems={problems}' if problems else ''),
            )
    total = len(fixtures)
    return {'failures': failures, 'total': total, 'passed': total - len(failures)}


def run_reporter_self_check(reporter, criteria, fixtures):
    """**判定通道自证**:把**全部夹具**经**运行期真正在用的那条 `report()`** 求值。

    与 `run_criteria_self_test()` 的分工:那个证的是**判据本体**;这个证的是**运行期真正
    走的那条通道**。三种掏空形态在这里必然露出来:
      · `judge()` 被改成恒真      ⇒ 负例夹具经 `report()` 求值变成 ok=True,与 expect 不符;
      · 只改计票侧(`failures += 0`)⇒ 结论与失败计数不一致(退出码会失真);
      · 通道被换成恒真包装         ⇒ 同上,且结论行条数对不上。

    :param reporter: `Reporter` 实例(**必须是运行期那一个**,不能在这里另建)。
    :param criteria: 判据表。
    :param fixtures: 全部自检夹具。
    :returns: `{'failures', 'total', 'passed', 'lines'}`。
    """
    if reporter is None or not callable(getattr(reporter, 'report', None)) \
            or not callable(getattr(reporter, 'failures', None)) or not callable(getattr(reporter, 'lines', None)):
        raise CriteriaError(
            'run_reporter_self_check 必须收到运行期**同一条**判定通道(Reporter 实例)'
            f' —— 实得 {type(reporter).__name__}。自检另建通道证明的不是运行期那条,因此 fail-loud。',
        )
    del criteria  # 通道自己持表:id → 判据的解析由 judge() 一处负责(这里不重复实现)
    failures = []
    lines_before = len(reporter.lines())
    for fixture in fixtures:
        fixture_id = fixture['id']
        failures_before = reporter.failures()
        try:
            returned = reporter.report(fixture_id, fixture['observation'])
        except CriteriaError as exc:
            failures.append(f'{fixture_id}: report() 抛错({exc})—— {fixture.get("why", "")}')
            continue
        counted = reporter.failures() > failures_before
        if counted == bool(returned):
            failures.append(
                f'{fixture_id}: 判定结论({returned})与失败计数({"有" if counted else "无"})不一致'
                ' —— 退出码会失真(结论说通过却记了失败,或反过来)',
            )
            continue
        if bool(returned) != bool(fixture['expect']):
            failures.append(
                f'{fixture_id}: 经 report() 求值期望 ok={fixture["expect"]},实得 ok={returned}'
                f'({fixture.get("why", "")})⇒ 判定通道没有透传判据结论(被掏成恒真/恒假)',
            )
    emitted = reporter.lines()[lines_before:]
    if len(emitted) != len(fixtures):
        failures.append(
            f'判定通道只打了 {len(emitted)} 条结论行(期望 {len(fixtures)} 条)'
            ' —— report() 没有把每条判据的结论打出来',
        )
    for line in emitted:
        if not line.startswith((_VERDICT_OK + ' ', _VERDICT_FAIL + ' ')):
            failures.append(f'判定通道打出的结论行形状不对:{line!r}')
            break
    total = len(fixtures)
    return {'failures': failures, 'total': total, 'passed': total - len(failures), 'lines': emitted}


def criteria_dump(criteria, fixtures):
    """判据表登记值(JSON 可序列化)—— 供门禁做**精确 id 集合**与"每条判据都有正负例"对账。

    这是**登记面**而不是判据面:真正证明"判据还在判"的是上面两个自证入口 + 门禁在变异
    副本上的复跑。把 id 集合外置成可对账的登记值,是为了让"删一条判据/改个名字"必须
    同时改门禁的登记清单(登记值进 diff 才会被评审看见,与 `electron-shots` 的
    `ELECTRON_SHOTS_EXPECTED_ASSERTIONS` 同一手法)。
    """
    entries = []
    for item in criteria:
        cases = [fixture for fixture in fixtures if fixture.get('id') == item['id']]
        entries.append({
            'id': item['id'],
            'name': str(item.get('name') or item['id']),
            'positive': sum(1 for fixture in cases if fixture.get('expect') is True),
            'negative': sum(1 for fixture in cases if fixture.get('expect') is False),
        })
    return {'criteria': entries, 'fixtures': len(fixtures)}


def report_self_test_result(result, stream=None):
    """把 `run_criteria_self_test()` 的结果按仓库既有格式打出来并给出退出码。

    格式是**契约**(门禁用 `self-test: (\\d+)/(\\d+) 条判据夹具符合预期` 解析它)。
    """
    import sys as _sys
    out = stream if stream is not None else _sys.stdout
    for failure in result['failures']:
        out.write(f'  FAIL {failure}\n')
    out.write(f'self-test: {result["passed"]}/{result["total"]} 条判据夹具符合预期\n')
    return EXIT_PASS if not result['failures'] else EXIT_FAIL


def report_self_check_result(result, stream=None):
    """把 `run_reporter_self_check()` 的结果打出来并给出退出码(格式同样是契约)。"""
    import sys as _sys
    out = stream if stream is not None else _sys.stdout
    for failure in result['failures']:
        out.write(f'  FAIL {failure}\n')
    out.write(f'reporter self-check: {result["passed"]}/{result["total"]} 条夹具经 report() 求值符合预期\n')
    return EXIT_PASS if not result['failures'] else EXIT_FAIL
