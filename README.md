# KingSMP Multi-Bot Panel

## Chạy dự án

Yêu cầu Node.js hiện đại (khuyến nghị Node.js 18 trở lên).

```bash
npm install
npm start
```

Sau khi server khởi động, mở `http://localhost:3001` trong trình duyệt. Trên Windows cũng có thể chạy `node setup.js`; script này cài dependencies rồi khởi động server, không ghi đè các file giao diện.

## Tính năng giao diện đã bổ sung

- **Log riêng từng bot:** ở trang Tài khoản, nhấn `Log` trên thẻ bot. Trang Log có tab cho từng bot và tab xem tất cả.
- **Gửi lệnh trong Log:** chọn bot nhận lệnh, nhập nội dung rồi nhấn Enter hoặc nút Gửi lệnh. Có thể chọn tất cả bot đang online.
- **Log nhanh trong Vision:** nhấn `≋ Log` hoặc phím `M`; nhập lệnh, nhấn Enter hoặc nút Gửi. Phím Esc thoát khỏi ô nhập.
- **Vision theo từng bot:** nhấn `Vision` ở thẻ tương ứng hoặc chọn bot trong trang Bot Vision.
- **Điều khiển Vision:** kéo chuột để xoay camera, cuộn/nhấn `+` và `−` để zoom, chỉnh FOV và chất lượng, bật toàn màn hình, ẩn tọa độ, tạm dừng stream.
- **Hiệu ứng hình ảnh:** Mặc định, Night Vision, Thermal, Grayscale, Retro, Vivid và Dream. Cài đặt FOV, chất lượng, hiệu ứng và chế độ camera được lưu riêng cho từng bot.
- **Thu gọn/phóng to thẻ bot:** mỗi thẻ có nút riêng. Trạng thái thu gọn và phóng to được lưu trong trình duyệt.
- **Hiệu ứng giao diện:** chuyển cảnh và chuyển trạng thái có animation; hỗ trợ thiết lập giảm chuyển động của hệ điều hành.

## Lưu ý

Log realtime được lưu trong bộ nhớ của trang hiện tại; tải lại trang sẽ bắt đầu phiên hiển thị log mới. Tài khoản Minecraft vẫn được lưu trong `accounts.json`. Bảo vệ file này vì nó chứa thông tin đăng nhập và cấu hình proxy.
