# 表情包商店 · 社区货架（sticker market）

T-10796。主人在应用里把角色「我的」表情包**上架到商店**，其他安装在 商店 → 表情包 里浏览、获取并在聊天里发送。对应 `docs/stickers-design.md` §5.2 的方案 C（独立服务 + LobeHub 身份）。官方货架（方案 B，CDN 上的 `sticker-catalog.json`）不变，两者在商店里合并显示，社区条目带「社区」标签，id 一律是 `u-…`。

## 运行

```bash
STICKER_MARKET_ADMIN_TOKEN=<随机串> node services/sticker-market/server.js   # 默认 127.0.0.1:8790，数据在 ./data
# 应用指向它：
PIXELPET_STICKER_MARKET_URL=http://127.0.0.1:8790 npm start
```

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | 监听地址 |
| `STICKER_MARKET_DIR` | `./data` | `db.json` 与 `files/`（zip、`previews/<sha256>.<ext>`） |
| `STICKER_MARKET_REVIEW` | `manual` | `manual` 先审后发；`auto` 提交即上架 |
| `STICKER_MARKET_ADMIN_TOKEN` | 空（审核接口关闭） | 审核接口的 Bearer 令牌 |
| `LOBEHUB_SERVER` | `https://app.lobehub.com` | 校验身份时访问的 LobeHub |

应用端没设 `PIXELPET_STICKER_MARKET_URL` 时，「上架到商店」按钮禁用并说明原因，商店只显示官方货架。

## 身份

应用发送 `lh login` 保存的令牌（`Oidc-Auth`）。服务把它转给 `<LOBEHUB_SERVER>/trpc/lambda/user.getUserState`：`userId` 是集合的所有者，`fullName || username` 是作者名。zip 里写的作者会被忽略。令牌不落盘，只按 sha256 缓存 5 分钟。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/sticker-catalog.json` | 已上架集合，格式同 `src/core/sticker-catalog.js` |
| GET | `/v1/files/<name>` | 已上架的 zip 或预览图（按内容寻址，不可变） |
| POST | `/v1/sticker-sets[?id=<自己的 id>]` | 请求体是集合 zip（§5.3），需要 `Oidc-Auth` 和 `X-Rights-Confirmed: yes`；带 `id` 时为新版本（仅所有者） |
| GET | `/v1/me/sticker-sets` | 当前账号上架的集合和审核状态 |
| DELETE | `/v1/sticker-sets/<id>` | 所有者下架 |
| GET | `/v1/admin/pending` | 待审核列表（管理员） |
| POST | `/v1/admin/sticker-sets/<id>/review` | `{ decision: approve \| reject, reason }`（管理员） |

服务端按应用校验下载的同一套规则（`validateSetZip`：路径越界、zip 炸弹、多余文件、按内容识别图片、张数和大小上限）校验上传，然后用服务端分配的 id、版本号和作者重新打包。授权只接受 `COMMUNITY_LICENSES`（`src/core/sticker-set.js`）。每个账号最多 20 组。新版本审核通过前，商店里仍是上一版。

## 审核

```bash
STICKER_MARKET_ADMIN_TOKEN=… node services/sticker-market/review.mjs list
STICKER_MARKET_ADMIN_TOKEN=… node services/sticker-market/review.mjs approve u-xxxxxx-1
STICKER_MARKET_ADMIN_TOKEN=… node services/sticker-market/review.mjs reject u-xxxxxx-1 "含有不适合全年龄的内容"
```

拒绝原因会出现在主人的 商店 → 表情包 → 我上架的。

## 尚未完成

- **公网部署**：目前只在本机运行，需要部署平台、域名和持久化存储，并把正式地址设为应用的默认 `PIXELPET_STICKER_MARKET_URL`。
- 举报入口、自动内容安全审核、点赞与排序（§5.4 ⑧）。
