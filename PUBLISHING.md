# Quy trình phát hành Task Mind

Tài liệu cho người bảo trì: cách publish extension lên **VS Code Marketplace** (và Open VSX),
thủ công lẫn tự động qua GitHub Actions.

## Tổng quan CI/CD

| Workflow | Khi nào chạy | Làm gì |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | push lên `main`, mọi PR | compile + lint + test + đóng gói thử `.vsix` (đính kèm artifact 14 ngày) |
| [`release.yml`](.github/workflows/release.yml) | push tag `vX.Y.Z` | build/test lại, kiểm tra tag khớp version, tạo **GitHub Release** kèm `.vsix`, publish **Marketplace** (cần secret `VSCE_PAT`) + **Open VSX** (tuỳ chọn, `OVSX_PAT`) |

Thiếu secret nào thì bước publish đó **tự bỏ qua** — GitHub Release vẫn được tạo, nên có thể
dùng release.yml ngay từ bây giờ chưa cần tài khoản Marketplace.

## Chuẩn bị một lần (trước lần publish đầu tiên)

### 1. Tạo publisher trên VS Code Marketplace

1. Vào <https://marketplace.visualstudio.com/manage> và đăng nhập bằng tài khoản Microsoft.
2. Tạo publisher với ID **`shiroenguyen`** — phải khớp đúng trường `"publisher"` trong
   [package.json](package.json). (Nếu ID đã bị chiếm, đổi cả hai sang ID khác.)

### 2. Tạo Personal Access Token (PAT) để publish

1. Vào <https://dev.azure.com> (Azure DevOps) — cùng tài khoản Microsoft ở trên; tạo organization
   nếu chưa có (tên gì cũng được, không liên quan tên publisher).
2. User settings (góc phải) → **Personal access tokens** → **New Token**:
   - **Organization**: chọn **All accessible organizations** (bắt buộc, nếu không vsce báo 401).
   - **Scopes**: Custom defined → **Marketplace → Manage**.
   - Expiration: tuỳ chọn (tối đa 1 năm — hết hạn thì tạo lại và cập nhật secret).
3. Copy token (chỉ hiện một lần).

### 3. Khai báo secret trên GitHub

Repo <https://github.com/xShiroeNguyenx/task-mind> → **Settings → Secrets and variables →
Actions → New repository secret**:

| Secret | Giá trị | Bắt buộc? |
|---|---|---|
| `VSCE_PAT` | PAT Azure DevOps ở bước 2 | Cần để publish Marketplace |
| `OVSX_PAT` | Token từ <https://open-vsx.org/user-settings/tokens> | Không — chỉ khi muốn phát hành thêm lên Open VSX (cho VSCodium, Cursor, Windsurf…) |

### 4. Checklist nội dung trước lần đầu lên Marketplace

- [x] `package.json` có `publisher`, `repository`, `license`, `icon`, `keywords`, `description`
- [x] `README.md` — chính là trang giới thiệu trên Marketplace
- [x] `CHANGELOG.md` — Marketplace hiển thị ở tab riêng
- [x] `LICENSE`
- [x] `.vscodeignore` đã loại file dev (`src/`, `scripts/`, report xuất thử, `*.vsix`…)
- [ ] Cân nhắc: ảnh chụp màn hình trong README (Marketplace render được ảnh theo URL GitHub raw)
- [ ] Cân nhắc: `galleryBanner` trong package.json (màu banner trang Marketplace)

## Phát hành một phiên bản (mỗi lần release)

1. **Tăng version** trong `package.json` (ví dụ `0.0.18` → `0.0.19`) — Marketplace không cho
   publish trùng version.
2. **Cập nhật `CHANGELOG.md`**: đổi mục `chưa phát hành` của version đó thành ngày phát hành,
   thêm mục mới nếu cần.
3. Commit và push lên `main`, đợi **CI xanh**.
4. Tag đúng version có tiền tố `v` rồi push tag — release.yml sẽ chạy toàn bộ phần còn lại:

```bash
git add package.json CHANGELOG.md
git commit -m "release: v0.0.19"
git push origin main
git tag v0.0.19
git push origin v0.0.19
```

> release.yml **từ chối chạy tiếp** nếu tag không khớp `package.json` version (đỡ publish nhầm).

5. Kiểm tra: tab **Actions** xanh → trang **Releases** có `.vsix` → sau vài phút extension
   xuất hiện/cập nhật tại `https://marketplace.visualstudio.com/items?itemName=shiroenguyen.task-mind`.

## Publish thủ công (không qua CI)

Máy local đang chạy **Node 18** nên cần polyfill `File` cho vsce (xem `scripts/file-polyfill.js`):

```bash
# Đóng gói
NODE_OPTIONS=--require=./scripts/file-polyfill.js npx @vscode/vsce@2.32.0 package

# Publish (sẽ hỏi PAT, hoặc truyền -p <PAT>)
NODE_OPTIONS=--require=./scripts/file-polyfill.js npx @vscode/vsce@2.32.0 publish
```

PowerShell thì đặt env trước: `$env:NODE_OPTIONS='--require=./scripts/file-polyfill.js'`.
Trên CI dùng Node 20 nên không cần polyfill.

## Sự cố thường gặp

| Lỗi | Nguyên nhân / cách xử lý |
|---|---|
| `401 Unauthorized` khi publish | PAT sai scope (cần Marketplace→Manage) hoặc không chọn "All accessible organizations"; hoặc PAT hết hạn → tạo lại, cập nhật secret `VSCE_PAT` |
| `ReferenceError: File is not defined` khi chạy vsce local | Node 18 — dùng lệnh có `NODE_OPTIONS=--require=./scripts/file-polyfill.js` như trên |
| Tag đã push nhưng quên bump version | Xoá tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), bump version, commit, tag lại |
| Publish trùng version | Marketplace từ chối — bump version mới, không thể ghi đè |
| File lạ lọt vào `.vsix` | Kiểm tra bằng `npx @vscode/vsce ls --tree`; bổ sung pattern vào `.vscodeignore` |
