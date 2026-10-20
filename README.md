# Báo cáo Thực hành Lab 3: Kết nối và duy trì kết nối giữa các service

> **Môn học**: Dịch vụ và Hệ thống phân tán (PTIT)  
> **Thời lượng**: 2 tiếng | **Giảng viên**: ThS Nguyễn Việt Dũng  

---

## 1. Cấu trúc mã nguồn

* `bank-service.js`: Cổng ngân hàng giả lập (cổng `4002`)
  * Hỗ trợ các biến môi trường inject fault: `DELAY_MS`, `FAIL_RATE`, `DROP_RATE`.
  * Xử lý `Idempotency-Key` qua header để chống trừ tiền trùng.
  * Theo dõi kết nối TCP (`server.on('connection')`), đóng kết nối nhàn rỗi sau 5 giây (`keepAliveTimeout = 5000`).
* `fee-service.js`: Hệ thống thanh toán học phí của trường (cổng `4001`)
  * In-memory database học phí sinh viên: sinh viên 1 (50tr), 2 (0đ), 3 (3.2tr).
  * HTTP Client với `http.Agent`: `keepAlive: true`, `maxSockets: 20`, timeout `4000ms`.
  * Cơ chế Retry thông minh có điều kiện: chỉ retry lỗi mạng tạm thời hoặc lỗi 500 với cùng `Idempotency-Key`; không retry lỗi nghiệp vụ (400, 402).
* `test-scenarios.js`: Script tự động hóa kiểm thử và đo đạc toàn bộ 4 tình huống.

---

## 2. Cách chạy kiểm thử

### Cài đặt
```bash
npm install
```

### Chạy kiểm thử tự động toàn bộ 4 tình huống
```bash
npm run test:all
# hoặc: node test-scenarios.js
```

### Chạy thủ công từng service
Terminal 1 (Bank):
```bash
node bank-service.js
```

Terminal 2 (Fee Service):
```bash
node fee-service.js
```

---

## 3. Bảng số liệu kiểm thử thực tế thu được

| Tình huống | Kịch bản mô phỏng | Kết quả kỳ vọng | Kết quả đo thực tế | Đánh giá |
| :--- | :--- | :--- | :--- | :--- |
| **TH 1** | Bank tắt, gọi thanh toán | 503 FAILED, `< 1.5s`; Fee Service sống; GET /fees nhanh; Bật lại Bank là thanh toán thành công ngay | 503 FAILED trong **27ms**; GET /fees trong **2ms**; Bật Bank là trả **201 PAID** ngay | **ĐẠT** |
| **TH 2** | `DELAY_MS=5000` | 504 PENDING trong `≤ 4.5s`; Bắn 20 thanh toán cùng lúc, GET /fees `< 300ms` | 504 PENDING trong **4008ms**; GET /fees trong **2ms** | **ĐẠT** |
| **TH 3** | Gửi 200 thanh toán (10 concurrent) | 200/200 thành công; TCP connections `≤ 20`; Nghỉ 6s gọi tiếp vẫn thông suốt | **200/200** thành công; TCP connections: **11** (≤ 20); Sau 6.5s nhàn rỗi: **5/5** thành công | **ĐẠT** |
| **TH 4a** | `DROP_RATE=0.3` (60 lệnh) | `duplicates = 0`; `≥ 54/60` PAID; Công nợ giảm chuẩn | `duplicates = 0`; **60/60** PAID; Công nợ giảm đúng từ 50tr về 44tr | **ĐẠT** |
| **TH 4b** | `FAIL_RATE=0.3` (60 lệnh) | `≥ 54/60` PAID nhờ retry; `duplicates = 0` | **57/60** PAID; `duplicates = 0` | **ĐẠT** |
| **TH 4c** | Thanh toán 25.000.000đ | 402 FAILED; Bank nhận đúng 1 request (không retry) | HTTP **402 FAILED**; Bank nhận đúng **1 request** | **ĐẠT** |
