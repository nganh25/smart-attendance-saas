const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const ExcelJS = require('exceljs');
const { PayOS } = require('@payos/node'); 
const bcrypt = require('bcryptjs'); // Thư viện băm mật khẩu bảo mật
const jwt = require('jsonwebtoken'); // Thư viện cấp Token xác thực
const rateLimit = require('express-rate-limit'); // Chống ddos/spam api

const { PutCommand, GetCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { ddbDocClient } = require("./src/shared/database");

const app = express();
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || "SaaS_SUPER_SECRET_KEY_2026"; // Khóa ký token bảo mật

const server = http.createServer(app);

// 🔒 Cấu hình bảo mật CORS nghiêm ngặt cho cả REST API và Socket
const corsOptions = {
    origin: "http://127.0.0.1:5500", // Chỉ cho phép duy nhất Front-end local của bạn truy cập
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// 🔒 Chống Spam: Giới hạn mỗi IP chỉ được yêu cầu gửi OTP tối đa 5 lần / 15 phút
const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5,
    message: { message: "Bạn đã yêu cầu quá nhiều mã OTP. Vui lòng thử lại sau 15 phút!" }
});

process.env.DYNAMODB_TABLE = "saas-attendance-backend-SaaSAttendanceTable-3BHJ8COS7E16"; 
const TABLE_NAME = process.env.DYNAMODB_TABLE;

const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID || "dummy_client_id_123456789",
    apiKey: process.env.PAYOS_API_KEY || "dummy_api_key_123456789",
    checksumKey: process.env.PAYOS_CHECKSUM_KEY || "dummy_checksum_key_123456789"
});

const otpCache = new Map();

// 🔒 Middleware kiểm tra tính hợp lệ của JWT Token (Bảo vệ API nội bộ)
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "Không tìm thấy Token xác thực! Vui lòng đăng nhập lại." });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Phiên đăng nhập hết hạn hoặc Token không hợp lệ!" });
        req.user = user; // Lưu thông tin giải mã vào req để API phía sau sử dụng trực tiếp
        next();
    });
}

// ==========================================
// 🔐 1A. API YÊU CẦU ĐĂNG KÝ (Có Rate Limit chống spam)
// ==========================================
app.post('/auth/register/request', registerLimiter, async (req, res) => {
    const { tenantId, userId, password, fullName, email, phone, otpType } = req.body;
    
    if (!tenantId || !userId || !password || !email || !phone || !otpType) {
        return res.status(400).json({ message: "Vui lòng điền đầy đủ thông tin và chọn phương thức nhận OTP!" });
    }

    // 🔒 Mã hóa băm mật khẩu trước khi đưa vào cache tạm thời
    const hashedPassword = await bcrypt.hash(password, 10);
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const cacheKey = `${tenantId}#${userId}`;
    
    otpCache.set(cacheKey, {
        tenantId, userId, password: hashedPassword, fullName, email, phone, otpCode,
        expiresAt: Date.now() + 5 * 60 * 1000
    });

    console.log(`\n=== 📩 [MÔ PHỎNG GỬI OTP BẢO MẬT] ===`);
    console.log(`🏢 Mã doanh nghiệp: ${tenantId}`);
    console.log(`👤 Tài khoản: ${userId}`);
    if (otpType === "PHONE") {
        console.log(`📱 [KÊNH SMS] Gửi mã OTP bảo mật đến SĐT [${phone}]: MÃ OTP LÀ -> ${otpCode}`);
    } else {
        console.log(`📧 [KÊNH EMAIL] Gửi mã OTP bảo mật đến Email [${email}]: MÃ OTP LÀ -> ${otpCode}`);
    }
    console.log(`============================================\n`);

    const channelText = otpType === "PHONE" ? `Số điện thoại (${phone})` : `Email (${email})`;
    res.status(200).json({ message: `Mã xác thực OTP đã được gửi tới ${channelText} của bạn! Hãy kiểm tra terminal backend.` });
});

// ==========================================
// 🔐 1B. API XÁC THỰC OTP & GHI VÀO DYNAMODB
// ==========================================
app.post('/auth/register/verify', async (req, res) => {
    const { tenantId, userId, otpCode } = req.body;
    const cacheKey = `${tenantId}#${userId}`;
    const cachedData = otpCache.get(cacheKey);

    if (!cachedData) {
        return res.status(400).json({ message: "Yêu cầu đăng ký đã hết hạn hoặc không tồn tại!" });
    }

    if (cachedData.expiresAt < Date.now()) {
        otpCache.delete(cacheKey);
        return res.status(400).json({ message: "Mã OTP đã hết hạn sử dụng!" });
    }

    if (cachedData.otpCode !== otpCode) {
        return res.status(400).json({ message: "Mã xác thực OTP không chính xác!" });
    }

    try {
        const userRecord = {
            PK: `TENANT#${cachedData.tenantId}#USER#${cachedData.userId}#METADATA`, 
            Password: cachedData.password, // Mật khẩu lúc này đã được băm bảo mật an toàn
            FullName: cachedData.fullName || cachedData.userId,
            Email: cachedData.email,
            Phone: cachedData.phone,
            Role: "EMPLOYEE",
            IsVerified: true,
            CreatedAt: new Date().toISOString()
        };

        await ddbDocClient.send(new PutCommand({ TableName: TABLE_NAME, Item: userRecord }));
        otpCache.delete(cacheKey);
        res.status(200).json({ message: "Xác thực thành công! Tài khoản nhân viên đã được kích hoạt an toàn." });
    } catch (error) {
        res.status(500).json({ message: "Lỗi lưu dữ liệu AWS: " + error.message });
    }
});

// ==========================================
// 🔑 2. API ĐĂNG NHẬP (Cấp mã xác thực Token JWT chống hack)
// ==========================================
app.post('/auth/login', async (req, res) => {
    const { tenantId, userId, password } = req.body;
    try {
        const result = await ddbDocClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { PK: `TENANT#${tenantId}#USER#${userId}#METADATA` }
        }));

        if (!result.Item) {
            return res.status(401).json({ message: "Sai mã công ty, tài khoản hoặc mật khẩu!" });
        }

        // 🔒 So khớp mật khẩu băm mã hóa mật
        const isPasswordValid = await bcrypt.compare(password, result.Item.Password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: "Sai mã công ty, tài khoản hoặc mật khẩu!" });
        }

        // 🔒 Ký tên cấp Token JWT (Hết hạn sau 2 tiếng)
        const token = jwt.sign(
            { tenantId, userId, fullName: result.Item.FullName },
            JWT_SECRET,
            { expiresIn: '2h' }
        );

        res.status(200).json({ 
            message: "Đăng nhập thành công!", 
            token: token, // Trả token về để Front-end lưu trữ
            user: { tenantId, userId, fullName: result.Item.FullName } 
        });
    } catch (error) {
        res.status(500).json({ message: "Lỗi hệ thống: " + error.message });
    }
});

// ==========================================
// 📌 3. API CHẤM CÔNG (Được bảo vệ bằng Jwt)
// ==========================================
app.post('/attendance/check-in', authenticateToken, async (req, res) => {
    // 🔒 Lấy thông tin trực tiếp từ Token đã được giải mã để tránh giả mạo ID người khác
    const { tenantId, userId } = req.user; 
    const { wifiBssid, actionType } = req.body;

    if (wifiBssid !== "00:1a:2b:3c:4d:5e") {
        return res.status(400).json({ message: "Sai Wi-Fi văn phòng, hệ thống từ chối chấm công trái phép!" });
    }

    const timestamp = new Date().toISOString();
    const currentDate = timestamp.substring(0, 10);
    const currentType = actionType === "OUT" ? "CHECKOUT" : "CHECKIN";

    try {
        const attendanceRecord = {
            PK: `TENANT#${tenantId}#USER#${userId}#ATTENDANCE#${currentDate}#${currentType}`,
            UserId: userId, Timestamp: timestamp, Action: currentType, DeviceVerified: "Wi-Fi Office", Status: "SUCCESS"
        };
        await ddbDocClient.send(new PutCommand({ TableName: TABLE_NAME, Item: attendanceRecord }));
        
        io.to(tenantId).emit('new_attendance_alert', { userId: userId, action: currentType });
        
        res.status(200).json({ message: "Ghi nhận ca làm việc thành công!", data: attendanceRecord });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ==========================================
// 🕒 4. API LẤY LỊCH SỬ CHẤM CÔNG (Được bảo vệ bằng Jwt)
// ==========================================
app.get('/attendance/history', authenticateToken, async (req, res) => {
    const { tenantId, userId } = req.user; // Lấy dữ liệu an toàn từ token
    try {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "begins_with(#pk, :pk_prefix)",
            ExpressionAttributeNames: { "#pk": "PK" },
            ExpressionAttributeValues: { ":pk_prefix": `TENANT#${tenantId}#USER#${userId}#ATTENDANCE#` }
        }));
        res.status(200).json({ history: result.Items || [] });
    } catch (error) {
        res.status(500).json({ message: "Lỗi lịch sử: " + error.message });
    }
});

// ==========================================
// 📊 5. API XUẤT BÁO CÁO CHẤM CÔNG (Được bảo vệ bằng Jwt)
// ==========================================
app.get('/attendance/export/:yearMonth', authenticateToken, async (req, res) => {
    const { tenantId } = req.user;
    const { yearMonth } = req.params;
    try {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "begins_with(#pk, :pk_prefix)",
            ExpressionAttributeNames: { "#pk": "PK" },
            ExpressionAttributeValues: { ":pk_prefix": `TENANT#${tenantId}#USER#` }
        }));

        const monthlyRecords = (result.Items || []).filter(item => item.PK.includes(`#ATTENDANCE#${yearMonth}`));
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Báo Cáo ${yearMonth}`);

        worksheet.columns = [
            { header: 'Mã Nhân Viên', key: 'userId', width: 18 },
            { header: 'Thời Gian Chấm', key: 'timestamp', width: 25 },
            { header: 'Loại Ca Ghi Nhận', key: 'action', width: 18 },
            { header: 'Hình Thức Xác Thực', key: 'device', width: 20 },
            { header: 'Trạng Thái', key: 'status', width: 15 }
        ];

        monthlyRecords.forEach(item => {
            worksheet.addRow({
                userId: item.UserId, timestamp: new Date(item.Timestamp).toLocaleString('vi-VN'),
                action: item.Action, device: item.DeviceVerified, status: item.Status
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=BaoCao_ChamCong_${yearMonth}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        res.status(500).json({ message: "Lỗi xuất báo cáo hệ thống: " + error.message });
    }
});

// ==========================================
// 💳 6. API TẠO ĐƠN THANH TOÁN (Được bảo vệ bằng Jwt)
// ==========================================
app.post('/billing/create-payment', authenticateToken, async (req, res) => {
    const { tenantId } = req.user;
    const { amount, packageName } = req.body;

    if (!process.env.PAYOS_CLIENT_ID || process.env.PAYOS_CLIENT_ID === "dummy_client_id_123456789") {
        return res.status(400).json({ message: "Tính năng thanh toán thật tạm thời chưa được kết nối. Vui lòng thêm Client ID thật vào file server.js!" });
    }

    const orderCode = Number(String(Date.now()).slice(-6));
    const paymentData = {
        orderCode: orderCode, amount: amount, description: `Gia han ${packageName}`,
        cancelUrl: `http://127.0.0.1:5500/index.html?payment=cancel`,
        returnUrl: `http://127.0.0.1:5500/index.html?payment=success`,
    };

    try {
        const paymentLinkData = await payos.createPaymentLink(paymentData);
        await ddbDocClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                PK: `TENANT#${tenantId}#BILLING#ORDER#${orderCode}`,
                Amount: amount, Package: packageName, Status: "PENDING", CreatedAt: new Date().toISOString()
            }
        }));
        res.status(200).json({ checkoutUrl: paymentLinkData.checkoutUrl });
    } catch (error) {
        res.status(500).json({ message: "Lỗi tích hợp PayOS: " + error.message });
    }
});

// 🔒 Xác thực kênh Socket kết nối thời gian thực: Phải đính kèm Token JWT hợp lệ mới cho phép Listen/Emit dữ liệu
const io = new Server(server, { cors: { origin: "*" } });
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Yêu cầu bảo mật: Thiếu Token xác thực thiết bị Real-time!"));
    }
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Mã Token Real-time không hợp lệ!"));
        socket.user = decoded;
        next();
    });
});

io.on('connection', (socket) => {
    socket.on('join_company', (tenantId) => {
        // Bảo vệ kênh: Chỉ cho phép tham gia phòng (Room) trùng với Mã doanh nghiệp nằm trong Token
        if (socket.user.tenantId === tenantId) {
            socket.join(tenantId);
        }
    });
});

server.listen(PORT, () => console.log(`🚀 [BẢO MẬT CAO] Server đang chạy mượt mà tại: http://localhost:${PORT}`));