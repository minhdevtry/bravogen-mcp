# HƯỚNG DẪN CẤU HÌNH BRAVOGEN MCP (DÀNH CHO DEV SQL & TRIỂN KHAI)

Không cần biết Docker hay cấu hình phức tạp. Bạn có thể tự làm trong 1 phút, hoặc **ném thẳng file `AGENT_INSTALL_INSTRUCTIONS.md` cho AI Agent** (Cursor / Claude Code / Roo Code) để nó tự cài đặt toàn bộ từ A đến Z!

---

### CÁCH 1: Ném cho AI Agent tự cài (Khuyên dùng - Nhanh nhất)
Mở Cursor hoặc Claude Code lên, copy nội dung file **`AGENT_INSTALL_INSTRUCTIONS.md`** gửi cho AI Agent. 
Agent sẽ tự động:
1. Nhận diện hệ điều hành của bạn (Windows, Mac hay Linux).
2. Tự cài đặt và tự đăng ký vào Claude Desktop / Cursor.
3. Hỏi bạn tài khoản mật khẩu và tự điền giúp bạn.
4. Hướng dẫn bạn reload để dùng được ngay lập tức!

---

### CÁCH 2: Tự cấu hình bằng tay (3 bước siêu đơn giản)

#### Bước 1: Điền tài khoản vào file `accounts.json`
Mở file `accounts.json` trong thư mục này lên (bằng Notepad), điền tài khoản mật khẩu:

```json
[
  {
    "username": "ten_tai_khoan_cua_ban",
    "password": "mat_khau_cua_ban"
  },
  {
    "username": "tai_khoan_dong_nghiep",
    "password": "mat_khau_dong_nghiep"
  }
]
```
*(Nếu muốn thêm nhiều người để dùng chung lượt gọi thì cứ thêm từng dòng như trên).*

#### Bước 2: Cài đặt lệnh toàn cục (Không lo về đường dẫn ổ đĩa)
Mở cửa sổ dòng lệnh (Terminal trên Mac/Linux hoặc CMD/PowerShell trên Windows) tại thư mục này và gõ:

```bash
npm install -g ./bravogen-mcp-1.0.0.tgz
```

Sau khi chạy xong lệnh trên, mở file cấu hình Claude Desktop hoặc Cursor lên, dán đoạn cấu hình này vào:

```json
{
  "mcpServers": {
    "bravogen": {
      "command": "bravogen-mcp"
    }
  }
}
```
*(Lệnh `bravogen-mcp` chạy được trên mọi máy tính Windows, Mac, Linux mà không phụ thuộc vào đường dẫn ổ đĩa `C:\`, `D:\` hay `/home/...`).*

#### Bước 3: Reload & Dùng luôn!

> ⚠️ **LƯU Ý QUAN TRỌNG:** Sau khi lưu cấu hình, bạn cần reload để phần mềm nhận MCP server mới:
> - **Trên Cursor:** Nhấn `Ctrl + Shift + P` -> gõ `Developer: Reload Window`.
> - **Trên Claude Desktop:** Tắt hẳn ứng dụng và mở lại.

Vào khung chat của Cursor hoặc Claude, hỏi các câu hỏi thực tế:
- *"Tra cứu thủ tục usp_B30StockLedger_Costing nhận các tham số gì?"*
- *"Bảng B30StockLedger và B30AccDoc liên kết qua trường nào?"*
- *"Viết cấu hình Layout XML thẻ BravoMoneyEvaluator làm tròn tiền VND."*
- *"Vẽ sơ đồ quy trình duyệt chứng từ nhiều cấp trong Bravo 10."*
- *"Kiểm tra hạn mức các tài khoản trong pool còn bao nhiêu lượt gọi?"*
