const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const ExcelJS = require('exceljs');
const { PayOS } = require('@payos/node');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { PutCommand, GetCommand, ScanCommand, QueryCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { ddbDocClient } = require("./src/shared/database");

const app = express();
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || "SaaS_SUPER_SECRET_KEY_2026";

const server = http.createServer(app);

// ─── Socket.IO ───
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
        if (socket.user.tenantId === tenantId) {
            socket.join(tenantId);
        }
    });
});

const corsOptions = {
    origin: (origin, callback) => {
        const allowedOrigins = [
            'http://127.0.0.1:5500',
            'http://localhost:5173',
            'http://127.0.0.1:5173'
        ];

        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Origin không được phép'));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());
const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { message: "Bạn đã yêu cầu quá nhiều mã OTP. Vui lòng thử lại sau 15 phút!" }
});

process.env.DYNAMODB_TABLE = "smart-attendance-database";
const TABLE_NAME = process.env.DYNAMODB_TABLE;

const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID || "dummy_client_id_123456789",
    apiKey: process.env.PAYOS_API_KEY || "dummy_api_key_123456789",
    checksumKey: process.env.PAYOS_CHECKSUM_KEY || "dummy_checksum_key_123456789"
});

const otpCache = new Map();

// ─── JWT Authentication Middleware ───
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "Không tìm thấy Token xác thực! Vui lòng đăng nhập lại." });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: "Phiên đăng nhập hết hạn hoặc Token không hợp lệ!" });
        req.user = user;
        next();
    });
}

// ═══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/auth/register/request', registerLimiter, async (req, res) => {
    const { tenantId, userId, password, fullName, email, phone, otpType } = req.body;

    if (!tenantId || !userId || !password || !email || !phone || !otpType) {
        return res.status(400).json({ message: "Vui lòng điền đầy đủ thông tin và chọn phương thức nhận OTP!" });
    }
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
            PK: `TENANT#${cachedData.tenantId}`,
            SK: `USER#${cachedData.userId}#METADATA`,
            Password: cachedData.password,
            FullName: cachedData.fullName || cachedData.userId,
            Email: cachedData.email,
            Phone: cachedData.phone,
            Role: "EMPLOYEE",
            IsActive: true,
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

app.post('/auth/login', async (req, res) => {
    const { tenantId, userId, password } = req.body;
    try {
        const result = await ddbDocClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: `USER#${userId}#METADATA`
            }
        }));

        if (!result.Item) {
            return res.status(401).json({ message: "Sai mã công ty, tài khoản hoặc mật khẩu!" });
        }
        const isPasswordValid = await bcrypt.compare(password, result.Item.Password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: "Sai mã công ty, tài khoản hoặc mật khẩu!" });
        }
        const token = jwt.sign(
            {
                tenantId,
                userId,
                fullName: result.Item.FullName,
                role: result.Item.Role || "EMPLOYEE"
            },
            JWT_SECRET,
            { expiresIn: '2h' }
        );

        res.status(200).json({
            message: "Đăng nhập thành công!",
            token: token,
            user: {
                tenantId,
                userId,
                fullName: result.Item.FullName,
                email: result.Item.Email || "",
                phone: result.Item.Phone || "",
                role: result.Item.Role || "EMPLOYEE"
            }
        });
    } catch (error) {
        res.status(500).json({ message: "Lỗi hệ thống: " + error.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  PROFILE ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/profile', authenticateToken, async (req, res) => {
    const { tenantId, userId } = req.user;
    try {
        const result = await ddbDocClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: `USER#${userId}#METADATA`
            }
        }));

        if (!result.Item) {
            return res.status(404).json({ message: "Không tìm thấy hồ sơ người dùng!" });
        }

        res.status(200).json({
            user: {
                tenantId,
                userId,
                fullName: result.Item.FullName || "",
                email: result.Item.Email || "",
                phone: result.Item.Phone || "",
                role: result.Item.Role || "EMPLOYEE",
                isActive: result.Item.IsActive !== false,
                createdAt: result.Item.CreatedAt || ""
            }
        });
    } catch (error) {
        res.status(500).json({ message: "Lỗi tải hồ sơ: " + error.message });
    }
});

app.patch('/profile/update', authenticateToken, async (req, res) => {
    const { tenantId, userId } = req.user;
    const { fullName, email, phone } = req.body;

    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    if (fullName !== undefined) {
        updateExpressions.push("#fn = :fullName");
        expressionAttributeNames["#fn"] = "FullName";
        expressionAttributeValues[":fullName"] = fullName;
    }
    if (email !== undefined) {
        updateExpressions.push("#em = :email");
        expressionAttributeNames["#em"] = "Email";
        expressionAttributeValues[":email"] = email;
    }
    if (phone !== undefined) {
        updateExpressions.push("#ph = :phone");
        expressionAttributeNames["#ph"] = "Phone";
        expressionAttributeValues[":phone"] = phone;
    }

    if (updateExpressions.length === 0) {
        return res.status(400).json({ message: "Không có thông tin thay đổi nào được gửi!" });
    }

    try {
        await ddbDocClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: `USER#${userId}#METADATA`
            },
            UpdateExpression: "SET " + updateExpressions.join(", "),
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));
        res.status(200).json({ message: "Cập nhật hồ sơ thành công!" });
    } catch (error) {
        res.status(500).json({ message: "Lỗi cập nhật hồ sơ: " + error.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  ATTENDANCE ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/attendance/check-in', authenticateToken, async (req, res) => {
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
            PK: `TENANT#${tenantId}`,
            SK: `USER#${userId}#ATTENDANCE#${currentDate}#${currentType}`,
            UserId: userId, Timestamp: timestamp, Action: currentType, DeviceVerified: "Wi-Fi Office", Status: "SUCCESS"
        };
        await ddbDocClient.send(new PutCommand({ TableName: TABLE_NAME, Item: attendanceRecord }));

        io.to(tenantId).emit('new_attendance_alert', { userId: userId, action: currentType });

        res.status(200).json({ message: "Ghi nhận ca làm việc thành công!", data: attendanceRecord });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/attendance/check-out', authenticateToken, async (req, res) => {
    const { tenantId, userId } = req.user;
    const { wifiBssid } = req.body;

    if (wifiBssid !== "00:1a:2b:3c:4d:5e") {
        return res.status(400).json({ message: "Sai Wi-Fi văn phòng, hệ thống từ chối chấm công trái phép!" });
    }

    const timestamp = new Date().toISOString();
    const currentDate = timestamp.substring(0, 10);

    try {
        const attendanceRecord = {
            PK: `TENANT#${tenantId}`,
            SK: `USER#${userId}#ATTENDANCE#${currentDate}#CHECKOUT`,
            UserId: userId, Timestamp: timestamp, Action: "CHECKOUT", DeviceVerified: "Wi-Fi Office", Status: "SUCCESS"
        };
        await ddbDocClient.send(new PutCommand({ TableName: TABLE_NAME, Item: attendanceRecord }));

        io.to(tenantId).emit('new_attendance_alert', { userId: userId, action: "CHECKOUT" });

        res.status(200).json({ message: "Check-out Ra Ca thành công!", data: attendanceRecord });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/attendance/history', authenticateToken, async (req, res) => {
    const { tenantId, userId, role } = req.user;
    const month = req.query.month;

    // Privileged History Retrieval
    let targetUserId = userId;
    if (req.query.userId && (role === "ADMIN" || role === "MANAGER")) {
        // Enforce boundary: MANAGER cannot view ADMIN logs
        if (role === "MANAGER") {
            try {
                const targetUserGet = await ddbDocClient.send(new GetCommand({
                    TableName: TABLE_NAME,
                    Key: {
                        PK: `TENANT#${tenantId}`,
                        SK: `USER#${req.query.userId}#METADATA`
                    }
                }));
                if (targetUserGet.Item && targetUserGet.Item.Role === "ADMIN") {
                    return res.status(403).json({ message: "Quyền hạn không hợp lệ! Trưởng phòng (MANAGER) không có quyền xem thông tin của quản trị viên (ADMIN)." });
                }
            } catch (e) {
                // ignore
            }
        }
        targetUserId = req.query.userId;
    }

    try {
        const result = await ddbDocClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues: {
                ":pk": `TENANT#${tenantId}`,
                ":sk_prefix": `USER#${targetUserId}#ATTENDANCE#`
            },
            ScanIndexForward: false
        }));

        let records = result.Items || [];

        if (month) {
            records = records.filter(item => item.SK.includes(`#ATTENDANCE#${month}`));
        }

        const checkins = records.filter(r => r.Action === "CHECKIN");
        const checkouts = records.filter(r => r.Action === "CHECKOUT");
        const uniqueDays = new Set(records.map(r => r.Timestamp?.substring(0, 10)));

        const summary = {
            totalRecords: records.length,
            totalCheckins: checkins.length,
            totalCheckouts: checkouts.length,
            totalDays: uniqueDays.size,
            latestRecord: records.length > 0 ? {
                action: records[0].Action,
                timestamp: records[0].Timestamp,
                device: records[0].DeviceVerified
            } : null
        };

        res.status(200).json({ history: records, summary, count: records.length });
    } catch (error) {
        res.status(500).json({ message: "Lỗi lịch sử: " + error.message });
    }
});

app.get('/attendance/export/:yearMonth', authenticateToken, async (req, res) => {
    const { tenantId, userId, role } = req.user;
    const { yearMonth } = req.params;
    const targetEmployeeId = req.query.userId; // optional target user from UI

    try {
        const result = await ddbDocClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues: {
                ":pk": `TENANT#${tenantId}`,
                ":sk_prefix": "USER#"
            }
        }));

        let monthlyRecords = (result.Items || []).filter(item => item.SK.includes(`#ATTENDANCE#${yearMonth}`));

        // Enforce role-based security boundaries for reports
        if (role === "EMPLOYEE") {
            // Employees can only export their own records
            monthlyRecords = monthlyRecords.filter(item => item.UserId === userId);
        } else if (role === "MANAGER") {
            // Manager cannot export Admin reports (filter out all ADMIN metadata records first)
            const adminUsersList = (result.Items || [])
                .filter(item => item.SK.endsWith("#METADATA") && item.Role === "ADMIN")
                .map(item => item.SK.split("#")[1]);

            monthlyRecords = monthlyRecords.filter(item => !adminUsersList.includes(item.UserId));

            if (targetEmployeeId && targetEmployeeId !== "ALL") {
                monthlyRecords = monthlyRecords.filter(item => item.UserId === targetEmployeeId);
            }
        } else if (role === "ADMIN") {
            if (targetEmployeeId && targetEmployeeId !== "ALL") {
                monthlyRecords = monthlyRecords.filter(item => item.UserId === targetEmployeeId);
            }
        }

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

// ═══════════════════════════════════════════════════════════════
//  ADMIN ROUTES & ATTENDANCE CRUD
// ═══════════════════════════════════════════════════════════════

app.get('/admin/users', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;

    // Only ADMIN and MANAGER roles can access the employee lists
    if (role !== "ADMIN" && role !== "MANAGER") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Bạn không có quyền truy cập thông tin nhân sự." });
    }

    try {
        const result = await ddbDocClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues: {
                ":pk": `TENANT#${tenantId}`,
                ":sk_prefix": "USER#"
            }
        }));

        let users = (result.Items || [])
            .filter(item => item.SK.endsWith("#METADATA"))
            .map(item => ({
                userId: item.SK.split("#")[1],
                fullName: item.FullName || "",
                email: item.Email || "",
                phone: item.Phone || "",
                role: item.Role || "EMPLOYEE",
                isActive: item.IsActive !== false,
                isVerified: item.IsVerified || false,
                createdAt: item.CreatedAt || ""
            }));

        // ENFORCED PRIVILEGE BOUNDARY: MANAGER can see all users EXCEPT other ADMINS
        if (role === "MANAGER") {
            users = users.filter(u => u.role !== "ADMIN");
        }

        res.status(200).json({ users, count: users.length, tenantId });
    } catch (error) {
        res.status(500).json({ message: "Lỗi tải danh sách: " + error.message });
    }
});

app.patch('/admin/users', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    const { targetUserId, newRole, isActive } = req.body;

    // Only ADMIN can modify user roles or active state
    if (role !== "ADMIN") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Chỉ quản trị viên cấp cao (ADMIN) mới có quyền chỉnh sửa nhân sự." });
    }

    if (!targetUserId) {
        return res.status(400).json({ message: "Thiếu thông tin người dùng cần cập nhật (targetUserId)!" });
    }

    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    if (newRole !== undefined) {
        const validRoles = ["EMPLOYEE", "MANAGER", "ADMIN"];
        if (!validRoles.includes(newRole)) {
            return res.status(400).json({ message: `Vai trò không hợp lệ! Chỉ chấp nhận: ${validRoles.join(", ")}` });
        }
        updateExpressions.push("#role = :role");
        expressionAttributeNames["#role"] = "Role";
        expressionAttributeValues[":role"] = newRole;
    }

    if (isActive !== undefined) {
        updateExpressions.push("#active = :active");
        expressionAttributeNames["#active"] = "IsActive";
        expressionAttributeValues[":active"] = isActive;
    }

    if (updateExpressions.length === 0) {
        return res.status(400).json({ message: "Không có thông tin thay đổi nào được gửi!" });
    }

    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "UpdatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    try {
        await ddbDocClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: `USER#${targetUserId}#METADATA`
            },
            UpdateExpression: "SET " + updateExpressions.join(", "),
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));
        res.status(200).json({ message: `Đã cập nhật thông tin người dùng ${targetUserId} thành công!` });
    } catch (error) {
        res.status(500).json({ message: "Lỗi cập nhật: " + error.message });
    }
});

// ─── CREATE User (Admin only — bypass OTP) ───
app.post('/admin/users/create', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    const { userId, password, fullName, email, phone, newRole } = req.body;

    if (role !== "ADMIN") {
        return res.status(403).json({ message: "Chỉ quản trị viên (ADMIN) mới có quyền tạo tài khoản mới!" });
    }

    if (!userId || !password) {
        return res.status(400).json({ message: "Vui lòng nhập tài khoản và mật khẩu!" });
    }

    // Check if user already exists
    try {
        const existing = await ddbDocClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { PK: `TENANT#${tenantId}`, SK: `USER#${userId}#METADATA` }
        }));
        if (existing.Item) {
            return res.status(409).json({ message: `Tài khoản "${userId}" đã tồn tại trong hệ thống!` });
        }
    } catch (e) { /* ignore */ }

    const hashedPassword = await bcrypt.hash(password, 10);
    const assignedRole = ["EMPLOYEE", "MANAGER", "ADMIN"].includes(newRole) ? newRole : "EMPLOYEE";

    try {
        await ddbDocClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                PK: `TENANT#${tenantId}`,
                SK: `USER#${userId}#METADATA`,
                Password: hashedPassword,
                FullName: fullName || userId,
                Email: email || "",
                Phone: phone || "",
                Role: assignedRole,
                IsActive: true,
                IsVerified: true,
                CreatedAt: new Date().toISOString()
            }
        }));
        res.status(200).json({ message: `Tạo tài khoản "${userId}" (${assignedRole}) thành công!` });
    } catch (error) {
        res.status(500).json({ message: "Lỗi tạo tài khoản: " + error.message });
    }
});

// ─── UPDATE User profile fields (Admin only — extends existing PATCH) ───
app.patch('/admin/users/profile', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    const { targetUserId, fullName, email, phone } = req.body;

    if (role !== "ADMIN") {
        return res.status(403).json({ message: "Chỉ quản trị viên (ADMIN) mới có quyền chỉnh sửa hồ sơ nhân viên!" });
    }

    if (!targetUserId) {
        return res.status(400).json({ message: "Thiếu thông tin người dùng cần cập nhật!" });
    }

    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    if (fullName !== undefined) {
        updateExpressions.push("#fn = :fullName");
        expressionAttributeNames["#fn"] = "FullName";
        expressionAttributeValues[":fullName"] = fullName;
    }
    if (email !== undefined) {
        updateExpressions.push("#em = :email");
        expressionAttributeNames["#em"] = "Email";
        expressionAttributeValues[":email"] = email;
    }
    if (phone !== undefined) {
        updateExpressions.push("#ph = :phone");
        expressionAttributeNames["#ph"] = "Phone";
        expressionAttributeValues[":phone"] = phone;
    }

    if (updateExpressions.length === 0) {
        return res.status(400).json({ message: "Không có thông tin thay đổi nào!" });
    }

    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "UpdatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    try {
        await ddbDocClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` },
            UpdateExpression: "SET " + updateExpressions.join(", "),
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));
        res.status(200).json({ message: `Đã cập nhật hồ sơ nhân viên ${targetUserId} thành công!` });
    } catch (error) {
        res.status(500).json({ message: "Lỗi cập nhật hồ sơ: " + error.message });
    }
});

// ─── DELETE User (Admin only) ───
app.delete('/admin/users/delete', authenticateToken, async (req, res) => {
    const { tenantId, userId: callerUserId, role } = req.user;
    const { targetUserId } = req.body;

    if (role !== "ADMIN") {
        return res.status(403).json({ message: "Chỉ quản trị viên (ADMIN) mới có quyền xóa tài khoản!" });
    }

    if (!targetUserId) {
        return res.status(400).json({ message: "Thiếu thông tin tài khoản cần xóa!" });
    }

    if (targetUserId === callerUserId) {
        return res.status(400).json({ message: "Bạn không thể tự xóa tài khoản của chính mình!" });
    }

    try {
        // Delete metadata record
        await ddbDocClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
        }));

        // Also clean up attendance records for this user
        const attendanceResult = await ddbDocClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues: {
                ":pk": `TENANT#${tenantId}`,
                ":sk_prefix": `USER#${targetUserId}#ATTENDANCE#`
            }
        }));

        const attendanceItems = attendanceResult.Items || [];
        for (const item of attendanceItems) {
            await ddbDocClient.send(new DeleteCommand({
                TableName: TABLE_NAME,
                Key: { PK: item.PK, SK: item.SK }
            }));
        }

        res.status(200).json({ message: `Đã xóa tài khoản "${targetUserId}" và ${attendanceItems.length} bản ghi chấm công liên quan.` });
    } catch (error) {
        res.status(500).json({ message: "Lỗi xóa tài khoản: " + error.message });
    }
});

// ─── Attendance CRUD APIs for ADMIN & MANAGER ───

// 1. GET User statistics list (each person summary)
app.get('/admin/attendance/summary', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    if (role !== "ADMIN" && role !== "MANAGER") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Bạn không có quyền truy cập dữ liệu thống kê nhân sự." });
    }

    try {
        const result = await ddbDocClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues: {
                ":pk": `TENANT#${tenantId}`,
                ":sk_prefix": "USER#"
            }
        }));

        const items = result.Items || [];
        const userMetadata = {};

        // Extract metadata to map user names and filter Admin roles out for Manager
        items.forEach(item => {
            if (item.SK.endsWith("#METADATA")) {
                const uId = item.SK.split("#")[1];
                if (role === "MANAGER" && item.Role === "ADMIN") {
                    return; // Skip Admin details
                }
                userMetadata[uId] = {
                    fullName: item.FullName || uId,
                    role: item.Role || "EMPLOYEE"
                };
            }
        });

        const stats = {};
        Object.keys(userMetadata).forEach(uId => {
            stats[uId] = {
                userId: uId,
                fullName: userMetadata[uId].fullName,
                role: userMetadata[uId].role,
                checkins: 0,
                checkouts: 0,
                days: new Set()
            };
        });

        // Loop items to sum statistics
        items.forEach(item => {
            if (item.SK.includes("#ATTENDANCE#")) {
                const uId = item.UserId || item.SK.split("#")[1];
                if (stats[uId]) {
                    if (item.Action === "CHECKIN") stats[uId].checkins++;
                    if (item.Action === "CHECKOUT") stats[uId].checkouts++;
                    const date = item.Timestamp?.substring(0, 10);
                    if (date) stats[uId].days.add(date);
                }
            }
        });

        const summaryList = Object.values(stats).map(s => ({
            userId: s.userId,
            fullName: s.fullName,
            role: s.role,
            checkins: s.checkins,
            checkouts: s.checkouts,
            days: s.days.size
        }));

        res.status(200).json({ summary: summaryList });
    } catch (e) {
        res.status(500).json({ message: "Lỗi thống kê nhân sự: " + e.message });
    }
});

// 2. CREATE Manual log
app.post('/admin/attendance', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    const { targetUserId, timestamp, action, device } = req.body;

    if (role !== "ADMIN" && role !== "MANAGER") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Bạn không có quyền thêm log chấm công." });
    }

    if (!targetUserId || !timestamp || !action) {
        return res.status(400).json({ message: "Vui lòng điền đầy đủ: Tài khoản, Thời gian, Loại ca!" });
    }

    const dateStr = timestamp.substring(0, 10);
    const actionType = action === "CHECKOUT" ? "CHECKOUT" : "CHECKIN";

    try {
        // Enforce boundary check: manager cannot modify Admin logs
        if (role === "MANAGER") {
            const checkUser = await ddbDocClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
            }));
            if (checkUser.Item && checkUser.Item.Role === "ADMIN") {
                return res.status(403).json({ message: "Không thể thêm log chấm công cho tài khoản ADMIN." });
            }
        }

        const logRecord = {
            PK: `TENANT#${tenantId}`,
            SK: `USER#${targetUserId}#ATTENDANCE#${dateStr}#${actionType}`,
            UserId: targetUserId,
            Timestamp: timestamp,
            Action: actionType,
            DeviceVerified: device || "Điều chỉnh thủ công",
            Status: "SUCCESS"
        };

        await ddbDocClient.send(new PutCommand({ TableName: TABLE_NAME, Item: logRecord }));
        res.status(200).json({ message: "Thêm bản ghi chấm công thủ công thành công!", record: logRecord });
    } catch (e) {
        res.status(500).json({ message: "Lỗi thêm bản ghi: " + e.message });
    }
});

// 3. UPDATE Log
app.patch('/admin/attendance', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    const { targetUserId, originalSk, newTimestamp, newAction, newDevice } = req.body;

    if (role !== "ADMIN" && role !== "MANAGER") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Bạn không có quyền chỉnh sửa log chấm công." });
    }

    if (!targetUserId || !originalSk || !newTimestamp || !newAction) {
        return res.status(400).json({ message: "Thiếu dữ liệu điều chỉnh!" });
    }

    try {
        if (role === "MANAGER") {
            const checkUser = await ddbDocClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
            }));
            if (checkUser.Item && checkUser.Item.Role === "ADMIN") {
                return res.status(403).json({ message: "Không thể sửa đổi dữ liệu chấm công của ADMIN." });
            }
        }

        // Delete old key first (SK coordinates contains original date & action type)
        await ddbDocClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: originalSk
            }
        }));

        // Write new updated record
        const dateStr = newTimestamp.substring(0, 10);
        const actionType = newAction === "CHECKOUT" ? "CHECKOUT" : "CHECKIN";
        const newSk = `USER#${targetUserId}#ATTENDANCE#${dateStr}#${actionType}`;

        const updatedRecord = {
            PK: `TENANT#${tenantId}`,
            SK: newSk,
            UserId: targetUserId,
            Timestamp: newTimestamp,
            Action: actionType,
            DeviceVerified: newDevice || "Chỉnh sửa thủ công",
            Status: "SUCCESS"
        };

        await ddbDocClient.send(new PutCommand({ TableName: TABLE_NAME, Item: updatedRecord }));
        res.status(200).json({ message: "Đã cập nhật bản ghi chấm công thành công!", record: updatedRecord });
    } catch (e) {
        res.status(500).json({ message: "Lỗi cập nhật: " + e.message });
    }
});

// 4. DELETE Log
app.delete('/admin/attendance', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    const { targetUserId, sk } = req.body;

    if (role !== "ADMIN" && role !== "MANAGER") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Bạn không có quyền xóa log chấm công." });
    }

    if (!targetUserId || !sk) {
        return res.status(400).json({ message: "Thiếu thông tin bản ghi cần xóa!" });
    }

    try {
        if (role === "MANAGER") {
            const checkUser = await ddbDocClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
            }));
            if (checkUser.Item && checkUser.Item.Role === "ADMIN") {
                return res.status(403).json({ message: "Không thể xóa dữ liệu chấm công của ADMIN." });
            }
        }

        await ddbDocClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: sk
            }
        }));
        res.status(200).json({ message: "Đã xóa bản ghi chấm công thành công!" });
    } catch (e) {
        res.status(500).json({ message: "Lỗi xóa bản ghi: " + e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  BILLING ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/billing/subscription', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;

    // Only company ADMIN can manage billing subscriptions
    if (role !== "ADMIN") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Bạn không có quyền truy cập gói cước thanh toán doanh nghiệp." });
    }

    try {
        const result = await ddbDocClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: "SUBSCRIPTION#CURRENT"
            }
        }));

        const subscription = result.Item || {
            plan: "FREE",
            status: "ACTIVE",
            maxUsers: 5,
            expiresAt: null
        };

        res.status(200).json({ subscription });
    } catch (error) {
        res.status(500).json({ message: "Lỗi tải gói dịch vụ: " + error.message });
    }
});

app.post('/billing/create-payment', authenticateToken, async (req, res) => {
    const { tenantId, role } = req.user;
    const { amount, packageName } = req.body;

    if (role !== "ADMIN") {
        return res.status(403).json({ message: "Quyền hạn không hợp lệ! Chỉ quản trị viên cấp cao mới được phép nâng cấp gói cước doanh nghiệp." });
    }

    if (!process.env.PAYOS_CLIENT_ID || process.env.PAYOS_CLIENT_ID === "dummy_client_id_123456789") {
        const orderCode = Number(String(Date.now()).slice(-6));
        try {
            await ddbDocClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    PK: `TENANT#${tenantId}`,
                    SK: `BILLING#ORDER#${orderCode}`,
                    Amount: amount, Package: packageName, Status: "PENDING", CreatedAt: new Date().toISOString()
                }
            }));
        } catch (e) {
            // ignore
        }
        return res.status(200).json({
            message: "Đã tạo đơn hàng thanh toán (chế độ mô phỏng)!",
            checkoutUrl: `http://localhost:3000/billing/webhook?mock=true`,
            orderCode
        });
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
                PK: `TENANT#${tenantId}`,
                SK: `BILLING#ORDER#${orderCode}`,
                Amount: amount, Package: packageName, Status: "PENDING", CreatedAt: new Date().toISOString()
            }
        }));
        res.status(200).json({ checkoutUrl: paymentLinkData.checkoutUrl });
    } catch (error) {
        res.status(500).json({ message: "Lỗi tích hợp PayOS: " + error.message });
    }
});

app.post('/billing/webhook', async (req, res) => {
    const { orderCode, status, tenantId } = req.body;

    if (!orderCode || !status) {
        return res.status(400).json({ message: "Thiếu thông tin webhook (orderCode, status)!" });
    }

    console.log(`[Webhook] Nhận thông báo thanh toán: Order #${orderCode}, Status: ${status}`);

    const statusMap = {
        "PAID": "COMPLETED",
        "CANCELLED": "CANCELLED",
        "EXPIRED": "EXPIRED",
        "PENDING": "PENDING"
    };
    const mappedStatus = statusMap[status] || status;

    if (tenantId) {
        try {
            await ddbDocClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: `TENANT#${tenantId}`,
                    SK: `BILLING#ORDER#${orderCode}`
                },
                UpdateExpression: "SET #st = :status, #paid = :paidAt",
                ExpressionAttributeNames: { "#st": "Status", "#paid": "PaidAt" },
                ExpressionAttributeValues: {
                    ":status": mappedStatus,
                    ":paidAt": mappedStatus === "COMPLETED" ? new Date().toISOString() : null
                }
            }));

            if (mappedStatus === "COMPLETED") {
                const expiresAt = new Date();
                expiresAt.setMonth(expiresAt.getMonth() + 1);

                await ddbDocClient.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: {
                        PK: `TENANT#${tenantId}`,
                        SK: "SUBSCRIPTION#CURRENT"
                    },
                    UpdateExpression: "SET #plan = :plan, #st = :status, #exp = :expires, #upd = :updated",
                    ExpressionAttributeNames: {
                        "#plan": "Plan",
                        "#st": "Status",
                        "#exp": "ExpiresAt",
                        "#upd": "UpdatedAt"
                    },
                    ExpressionAttributeValues: {
                        ":plan": "PRO",
                        ":status": "ACTIVE",
                        ":expires": expiresAt.toISOString(),
                        ":updated": new Date().toISOString()
                    }
                }));
            }
        } catch (e) {
            console.error("Lỗi cập nhật hóa đơn/gói cước local:", e);
        }
    }

    res.status(200).json({ message: "Webhook đã được xử lý thành công!", orderCode, status: mappedStatus });
});

// ═══════════════════════════════════════════════════════════════
//  HEALTH CHECK & START SERVER
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.status(200).json({
        service: "Smart Attendance SaaS API",
        status: "OK",
        version: "1.0.0",
        endpoints: [
            "POST /auth/login",
            "POST /auth/register/request",
            "POST /auth/register/verify",
            "GET  /profile",
            "POST /attendance/check-in",
            "POST /attendance/check-out",
            "GET  /attendance/history",
            "GET  /admin/users",
            "GET  /admin/attendance/summary",
            "POST /admin/attendance",
            "PATCH /admin/attendance",
            "DELETE /admin/attendance",
            "GET  /billing/subscription",
        ]
    });
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
