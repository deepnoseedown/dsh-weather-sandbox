# 提交流程（给下一个接手的助手）

> 现在是 2026-11-25 13:05。本地一切就绪，**只差推送和提 PR**。

---

## 一、现在什么状态

| 项 | 状态 |
|---|---|
| 仓库 | `https://github.com/deepnoseedown/dsh-weather-sandbox` |
| 首次提交 | 2026-11-24 13:53 |
| **仓库年龄** | **约 23.2 小时**（差不到 1 小时满一天） |
| 本地提交 | ✅ 全部完成，干净 |
| **待推送** | **2 个提交没上去** |
| 网络 | ❌ **github.com:443 连不上**（DNS 正常，端口被拒） |

### 待推送的两个提交

```
c4a2c68  动作扩到 50 个 + 云主体 + 角色接入 + 文档补齐
f29359b  角色素材接入 + 截图转WebP瘦身 + 署名与交接文档
```

---

## 二、第一步：把推送搞上去（唯一障碍）

**症状**：

```
fatal: unable to access '...': Failed to connect to github.com port 443
```

DNS 能解析（`github.com → 57.155.223.240`），但 443 连不上。**这不是代码问题。**

### 按顺序试这四个办法

**① 直接重试几次**

网络时好时坏，多试几次可能就通了：

```powershell
cd C:\Users\88888888\.dsh\profiles\desktop\local-packages\dsh-weather-sandbox
git push origin main
```

**② 检查有没有代理在跑**

```powershell
# 看系统代理
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable, ProxyServer
# 看 git 自己的代理配置
git config --global --get http.proxy
git config --global --get https.proxy
```

如果用户有代理（比如 Clash 的 7890 端口）：

```powershell
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
git push origin main
```

**③ 换 SSH 试试**（HTTPS 被墙时 SSH 有时能通）

```powershell
ssh -T git@github.com          # 先测通不通
git remote set-url origin git@github.com:deepnoseedown/dsh-weather-sandbox.git
git push origin main
```

**④ 用 GitHub API 推**（如果 git 协议全挂）

之前成功过一次（`87db634` 那个提交就是用 API 推上去的）。
但这一步要写脚本调 API，**先试前三个，都不行再考虑**。

---

## 三、第二步：确认仓库满 24 小时

**市场要求：仓库创建 ≥ 1 天。**

- 创建时间：**2026-11-24 13:53**
- 满一天：**2026-11-25 13:53**
- 现在已经 13:05，**等到 13:53 之后就可以提**

**验证方法**：打开 `https://api.github.com/repos/deepnoseedown/dsh-weather-sandbox`，
看 `created_at` 字段，和当前时间差是否 ≥ 24 小时。

---

## 四、第三步：提 PR 到 awesome-dsh-plugin

**目标仓库**：`awesome-dsh-plugin/awesome-dsh-plugin`

**要加的文件**：`data/plugins/deepnoseedown__dsh-weather-sandbox.yml`

### 文件内容（照这个写）

```yaml
name: dsh-weather-sandbox
repo: deepnoseedown/dsh-weather-sandbox
description: 天气演化沙盒：一片会自己变天气的海。太阳升落、云飘云散、风从真实气压差吹来，草地跟着风起伏。下雨下雪积水融雪全自动循环，草地里住着一条会自己走走停停、看得见天气变化的大肥鱼。
tags:
  - weather
  - simulation
  - ocean
  - webgl
  - sandbox
```

### 提 PR 前的自检（这几项都要过）

| 检查 | 怎么查 | 现状 |
|---|---|---|
| `package.json` 有 `dsh.bundle` | 读文件 | ✅ 有（`./cordis.patch.yml`） |
| `keywords` 含 `dsh-plugin` | 读文件 | ✅ 有 |
| README 存在且完整 | 看文件 | ✅ 有 |
| LICENSE 存在 | 看文件 | ✅ MIT |
| 仓库 ≥ 1 天 | API 查 `created_at` | ⏳ 差 48 分钟 |
| 能安装 | 本地已装并跑起来 | ✅ |

### PR 流程

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 新建 `data/plugins/deepnoseedown__dsh-weather-sandbox.yml`
3. 提交 PR，标题类似 `Add dsh-weather-sandbox`
4. PR 描述里写清楚：这个插件做什么、依赖什么、怎么验证

---

## 五、这次改了什么（如果需要写 PR 描述）

**本地已完成的准备（都提交在 `c4a2c68` 里）：**

| 项 | 内容 |
|---|---|
| 动作素材 | 50 个，3.5 MB，单个全部 < 200 KB |
| 云主体 | 独立 WebGL 层，fbm 噪声云团，四层无周期运动 |
| 角色 | 引擎内 3D Pass，canvas 逐帧抠黑底（素材无 alpha） |
| 天气联动 | 雨/雪/雷/冷 → 对应动作 |
| 文档 | `HANDOFF.md` 交接、`PET-INTEGRATION.md` 技术交底 |
| 署名 | d-dev0101 / ifer47 / PC2005-cloud（三位，MIT） |
| 截图 | 三张 WebP，共 588 KB（原 4.6 MB PNG） |

**插件本体大小：3.14 MB（不含 .git），零依赖。**

---

## 六、要提醒用户的事

1. **推送卡在网络，不是卡在时间。** 之前判断"差一天"是对的，但现在多了一个网络障碍。
2. **13:53 之后仓库才满 24 小时**，到点再提 PR，别提前。
3. **网络问题可能需要用户开代理**。如果四个办法都失败，直接问用户：
   > "github.com:443 连不上，你有代理吗？开了告诉我端口。"

---

## 七、如果一切顺利，命令清单

```powershell
# 1. 推送（可能要多试几次或配代理）
cd C:\Users\88888888\.dsh\profiles\desktop\local-packages\dsh-weather-sandbox
git push origin main

# 2. 确认推上去了
git status -sb
# 应该显示 ## main...origin/main（没有 ahead）

# 3. 确认仓库年龄（要 ≥ 1 天）
# 打开 https://api.github.com/repos/deepnoseedown/dsh-weather-sandbox 看 created_at

# 4. 提 PR（在 GitHub 网页上操作）
#    Fork → 加 yml → 发 PR
```

---

## 八、一句话

**代码、素材、文档、署名全弄好了，提交也做完了。**
**现在只卡在一个端口上。网络通了，10 分钟就能提交完。**
