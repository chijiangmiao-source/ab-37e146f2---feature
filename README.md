# LR(1) 文法复核台

束线控制脚本新增指令上线前，对文法进行复核：粘贴终结符、非终结符、起始符与产生式，
系统完成校验并构造**规范 LR(1) 项目集**，无冲突时展示稳定编号的项目集与 ACTION/GOTO
动作表；存在冲突时按**状态编号 → 展望符 → 动作顺序**稳定给出首个冲突及可核查的前缀证据。

纯 Node.js 标准库实现，零外部依赖。

## 快速开始

### Docker Compose（推荐）

```bash
# 启动复核页（http://localhost:3000）与健康路径（/healthz）
docker compose up --build app

# 运行一次性验收服务 verify（围绕无冲突文法、两类冲突证据与健康响应，
# 完成代码测试、页面构建检查和 API/HTTP 冒烟；以退出码报告结果）
docker compose run --rm verify
echo "verify exit=$?"

# 或者一次性把 app 与 verify 一起拉起，退出码取自 verify
docker compose --profile verify up --build --abort-on-container-exit --exit-code-from verify
```

### 本地（无需 Docker）

```bash
npm test          # 代码测试（node --test）
npm run build     # 页面构建检查（web/build.js --check）
npm start         # 启动复核页 http://localhost:3000
npm run verify    # 一次性验收：构建页面、拉起本地服务、跑全部检查并以退出码报告
```

## 文法输入的分隔规则

- **符号表**：终结符 / 非终结符以**空白或逗号**分隔；多字符符号直接书写（如 `ELSE`、`IDENT`）。
- **产生式**：每行一条，箭头为 `->`、`::=` 或 `→`；右部符号以**空格分隔**（因此符号可含任意非空白字符）。
- **候选项**：右部中独立的 `|` 记号分隔多个候选。
- **空产生式**：右部留空，或写 `ε` / `eps`（不得与其他符号混用）。
- **注释**：以 `#` 或 `//` 开头的行被忽略。
- **递归**：左递归、右递归与相互递归均直接支持。
- **保留记号**：`$`（输入结束符）、`ε`、`eps`、`->`、`::=`、`→`、`|` 不能用作符号。

## 校验与构造

**校验**（带行号/符号定位）：

| 错误码 | 含义 |
| --- | --- |
| `illegal-symbol` | 保留记号被用作符号 |
| `undefined-symbol` | 产生式引用了未声明的符号 |
| `duplicate-production` | 重复产生式（给出两处行号） |
| `unreachable-start` | 起始符没有任何产生式，起始规则不可达 |
| `duplicate-declaration` / `declaration-conflict` | 重复声明 / 终结与非终结重名 |
| `lhs-not-nonterminal` | 终结符被用作产生式左部 |
| `missing-arrow` / `bad-lhs` / `epsilon-mixed` 等 | 行格式错误 |

另以**告警**报告从起始符不可达的非终结符（`unreachable-nonterminal`）。

**构造**：计算 nullable、FIRST、闭包与 goto，按 BFS 顺序为项目集分配**稳定编号**
（同一文法多次复核编号一致）。无冲突时展示项目集与 ACTION/GOTO 表。

**冲突报告**：出现移进/归约或归约/归约冲突时，按（状态编号，展望符，动作顺序
shift < reduce < accept，归约按产生式编号）稳定给出**首个冲突**，包括：

- 冲突状态编号与展望符；
- 两项竞争动作（各自文本与来源项目）；
- 冲突状态的全部 LR(1) 项目（核项目加粗）；
- **可核查的前缀证据**：从 I0 出发读入该符号串即到达冲突状态（附状态路径），
  再读入展望符即触发冲突。

**草稿与过期保护**：编辑内容自动保存在浏览器 localStorage，刷新后恢复；修改草稿或
点击"取消计算"后，过期响应会被丢弃，不会改写当前结论（界面上以"过期结果"标注）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz`（或 `/health`） | 健康检查，返回 `{"status":"ok"}` |
| `GET` | `/` | 复核页面（静态资源来自 `web/dist`，缺失时回退 `web/src`） |
| `POST` | `/api/review` | 文法复核；请求体 `{"terminals","nonterminals","start","productions"}`（均为字符串） |

`/api/review` 响应：

- 校验失败：`{"ok": false, "errors": [{code,message,line?,symbol?}], "warnings": [...]}`
- 成功：`{"ok": true, "warnings": [...], "grammar": {...}, "analysis": {...}}`，其中
  `analysis` 含 `nullable`、`first`、`states`（稳定编号的项目集与转移）、
  `actionTable`、`conflictFree`、`conflictCount` 与 `firstConflict`
  （`type`、`state`、`lookahead`、`actions[]`、`stateItems[]`、`prefix{symbols,states}`）。

## 一次性验收服务 `verify`

`verify` 依次执行并以退出码报告（0 通过 / 1 失败）：

1. **代码测试**：`node --test server/test/`（文法解析、nullable/FIRST/闭包/goto、
   冲突定位、HTTP API）。
2. **页面构建检查**：`web/build.js --check` 校验页面资源、JS 语法与 HTML 引用，
   产出 `web/dist` 及校验和清单。
3. **API/HTTP 冒烟**（对 `APP_URL`，默认 `http://app:3000`）：
   - `/healthz` 健康响应；
   - 复核页与静态资源可达；
   - 无冲突表达式文法 → 22 个规范 LR(1) 项目集、唯一 accept 动作；
   - `E -> E + E | id` → 首个冲突为移进/归约，证据字段齐全且前缀可重放；
   - `S -> A | B; A -> x; B -> x` → 首个冲突为归约/归约，动作按产生式编号排序；
   - 非法文法 → 返回带定位的校验错误。

Compose 中 `verify` 通过 `depends_on: service_healthy` 等待 app 就绪，执行完毕即退出。

## 目录结构

```
├── Dockerfile             # 单镜像：构建页面 + 运行服务（含 HEALTHCHECK）
├── docker-compose.yml     # app（复核页+健康路径）与 verify（一次性验收）
├── package.json
├── server/
│   └── src/
│       ├── grammar.js     # 文法解析与校验（分隔规则、错误定位）
│       ├── lr1.js         # nullable/FIRST/闭包/goto、规范 LR(1)、冲突与证据
│       ├── review.js      # 复核编排
│       └── index.js       # HTTP 服务（页面、/api/review、/healthz）
│   └── test/              # node:test 测试套件
├── web/
│   ├── src/               # 复核页源码（index.html / app.js / styles.css）
│   └── build.js           # 页面构建与检查脚本（产出 web/dist）
└── verify/
    ├── verify             # 可执行入口（本地模式自动拉起服务并清理）
    └── verify.js          # 验收逻辑（三阶段，退出码报告）
```
