# fundView / Trading Agent

一个本地优先的基金估值与投研分析工作台，用来查看个人基金持仓、实时估值、基金公告/快讯、证据链和研究员分析。

> 重要声明：本项目仅用于个人研究、数据整理和工程实验，不构成任何投资建议、法律建议、税务建议或理财建议。市场数据、模型输出和 OCR 结果都可能错误，请自行判断风险。

## 功能特性

- 持仓估值：展示基金代码、名称、估值涨跌、份额、成本、市值、今日盈亏和累计盈亏。
- 排序与编辑：支持按基金、估值、份额、成本、市值、盈亏排序，并编辑持仓。
- 市场概览：展示主要指数和市场指标。
- 基金详情：展开单只基金后查看证据链、历史研究、建议验证、持仓穿透、数据源状态。
- 基金资讯：仅展示基金相关的正式资讯/公告类内容，过滤普通论坛评论。
- 研究员分析：基于行情、持仓、公告、风险和交易纪律生成多角度分析。
- 建议验证：标记某条研究建议已执行后，系统记录基准净值，并在后续用最新净值做验证。
- 模型配置：可在页面里配置 OpenAI 兼容接口或 Anthropic 兼容接口。
- OCR 导入：可选接入百度 OCR，用截图识别持仓信息。

## 技术栈

- 前端：React 19、TypeScript、Vite、Tailwind CSS
- 后端：Express
- 数据库：Turso / libSQL
- 图标：lucide-react
- 可选能力：百度 OCR、OpenAI 兼容模型、Anthropic 兼容模型

## 本地启动

安装依赖：

```bash
npm install
```

复制环境变量示例：

```bash
cp .env.example .env.local
```

填写 `.env.local` 中的数据库配置：

```env
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token
```

初始化数据库：

```bash
npm run db:init
node scripts/migrate-v2.mjs
```

启动项目：

```bash
npm run dev
```

## 环境变量

必填：

- `TURSO_DATABASE_URL`：Turso/libSQL 数据库地址
- `TURSO_AUTH_TOKEN`：Turso/libSQL 访问令牌

可选：

- `BAIDU_OCR_API_KEY`：百度 OCR API Key
- `BAIDU_OCR_SECRET_KEY`：百度 OCR Secret Key
- `BAIDU_OCR_DEFAULT_API`：百度 OCR 接口类型，默认 `accurate_basic`
- `LLM_API_KEY`：默认大模型 API Key
- `LLM_BASE_URL`：默认大模型接口地址
- `LLM_MODEL`：默认模型名称
- `API_PORT`：后端端口

不要提交 `.env.local`、数据库文件、LLM 配置文件、截图或个人持仓数据。

## 数据源说明

当前项目使用东方财富/天天基金网页资源获取行情、基金净值、基金持仓穿透、基金公告和基金相关正式资讯。这些接口不是本项目声明的官方稳定 SDK，可能变更、限流或不可用。

如果你要将项目用于公开服务、商业场景或高频访问，请自行确认数据源服务条款，并优先替换为授权数据 API。

更多说明见 [THIRD_PARTY_DATA.md](./THIRD_PARTY_DATA.md)。

## 大模型说明

项目不强制依赖大模型。未配置模型时，研究员分析会降级为规则逻辑。

配置模型后，系统可能会把基金名称、行情数据、持仓穿透、公告摘要和研究上下文发送给你配置的模型服务。请确认你接受对应服务商的隐私政策和使用条款。

## 安全说明

- 本项目默认适合本地使用，不是已经加固的公开多用户系统。
- 如果要部署到公网，请先增加认证、权限、限流、日志脱敏和数据隔离。
- 如果密钥曾经泄露，请立即旋转密钥。只从 Git 历史删除是不够的。

详细说明见 [SECURITY.md](./SECURITY.md)。

## 发布前检查

```bash
npm run build
npm run audit:deps
git status --short
```

建议在推送前再做一次密钥扫描，确认没有提交 `.env.local`、数据库文件或个人数据。

## 许可证

本项目使用 Apache-2.0 许可证。详见 [LICENSE](./LICENSE)。
