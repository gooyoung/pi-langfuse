# 部署与发布说明

本文档用于说明 `pi-langfuse` 的标准发布流程，供后续 agent 或维护者执行参考。

当前仓库的自动发布由 [`.github/workflows/publish.yml`](file:///Users/hezhiqing/Desktop/github/pi/pi-langfuse/.github/workflows/publish.yml) 驱动，触发条件是：

- GitHub Release 被发布（`release.published`）
- Release 对应的 tag 必须与 `package.json` 中的版本一致
- 工作流会执行 `npm ci`、`npm run typecheck`、`npm pack --dry-run`，最后执行 `npm publish`

这意味着：

- 只创建 tag，不创建 GitHub Release，不会触发自动发布
- tag 名必须是 `v<package.json version>`，例如 `v1.4.2`

## 前置条件

- 已具备仓库 push 和 release 权限
- GitHub 仓库已配置 `NPM_TOKEN` secret
- 本地已安装 `npm`、`git`、`gh`
- `gh auth status` 已通过认证

可选检查命令：

```bash
gh auth status
git remote -v
```

### Codex Desktop 与 macOS Keychain

macOS 上的 `gh` 默认将 OAuth token 保存在 Keychain。Codex Desktop 的右侧终端可以正常读取
Keychain，但普通沙箱命令可能无法读取，从而将“无法访问 keyring”误报为 `token is invalid`。

遇到这种情况时：

- 不要仅凭沙箱内的失败结果要求重新登录；
- 先以授权的沙箱外执行方式复查 `gh auth status`；
- 如果结果包含 `Logged in ... (keyring)`，认证有效，后续需要认证的 `gh` 命令也应以授权方式运行；
- 不要使用 `--insecure-storage`，不要把 token 写入环境文件或仓库，也不要在日志中输出 token。

## 标准发布流程

建议在 `main` 分支执行，且工作区保持干净。

### 1. 同步代码

```bash
git checkout main
git pull origin main
git status
```

### 2. 更新版本号

按实际需要选择一个版本命令。这里使用 `--no-git-tag-version`，避免 `npm version` 自动创建 tag，统一由后续步骤手动创建。

```bash
npm version patch --no-git-tag-version
```

也可以使用：

```bash
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

### 3. 本地校验

```bash
npm ci
npm run typecheck
npm pack --dry-run
```

### 4. 提交版本变更

```bash
git add package.json package-lock.json
git commit -m "release: v$(node -p "require('./package.json').version")"
git push origin main
```

如果本次发布还包含代码变更，先将代码和版本号一起提交，再执行 `git push origin main`。

### 5. 创建并推送 tag

```bash
TAG="v$(node -p "require('./package.json').version")"
git tag -a "$TAG" -m "release: $TAG"
git push origin "$TAG"
```

### 6. 创建 GitHub Release

`publish.yml` 监听的是 Release 发布事件，因此这里必须创建 Release。

```bash
TAG="v$(node -p "require('./package.json').version")"
gh release create "$TAG" \
  --title "$TAG" \
  --generate-notes
```

执行完成后，GitHub Actions 会自动开始发布到 npm。

## 一次性命令清单

适合已经完成代码修改，准备正式发版时直接执行：

```bash
git checkout main
git pull origin main
npm version patch --no-git-tag-version
npm ci
npm run typecheck
npm pack --dry-run
git add package.json package-lock.json
git commit -m "release: v$(node -p "require('./package.json').version")"
git push origin main
TAG="v$(node -p "require('./package.json').version")"
git tag -a "$TAG" -m "release: $TAG"
git push origin "$TAG"
gh release create "$TAG" --title "$TAG" --generate-notes
```

## 已经完成 commit 后的最小发布命令

如果版本号已经更新并且 commit 已经推送到远端，只需要执行下面几步：

```bash
git checkout main
git pull origin main
TAG="v$(node -p "require('./package.json').version")"
git tag -a "$TAG" -m "release: $TAG"
git push origin "$TAG"
gh release create "$TAG" --title "$TAG" --generate-notes
```

## 发布后检查

### 检查 GitHub Actions

```bash
gh run list --workflow publish.yml --limit 5
```

### 检查 npm 版本

```bash
npm view pi-langfuse version
```

## 常见问题

### 1. 创建了 tag，但没有发布

原因通常是只推送了 tag，没有创建 GitHub Release。补执行以下命令即可：

```bash
TAG="v$(node -p "require('./package.json').version")"
gh release create "$TAG" --title "$TAG" --generate-notes
```

### 2. GitHub Actions 报 tag 与版本不一致

工作流会校验：

```bash
v$(node -p 'require("./package.json").version')
```

如果当前 `package.json` 是 `1.4.2`，则 tag 必须是 `v1.4.2`。

### 3. 需要重新发布同一个版本

npm 不允许重复发布同一个版本。需要：

- 更新 `package.json` 版本号
- 重新 commit
- 重新创建新的 tag
- 重新创建新的 GitHub Release

## 推荐给后续 agent 的执行规则

- 先确认当前版本号和目标版本号
- 先完成代码提交，再创建 tag
- 先推送 tag，再创建 GitHub Release
- 不要假设「push tag」会自动触发发布
- 创建 Release 前，确认 tag 与 `package.json` 版本完全一致
