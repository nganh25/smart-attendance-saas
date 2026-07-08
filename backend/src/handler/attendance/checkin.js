const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");

exports.handler = async (event) => {
    try {
        if (event.requestContext && event.requestContext.http.method === "OPTIONS") {
            return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization"
                },
                body: ""
            };
        }

        const body = JSON.parse(event.body || "{}");
        const { tenantId, userId, wifiBssid, gpsLocation, actionType } = body; 

        if (!tenantId || !userId) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Thiếu thông tin tenantId hoặc userId bắt buộc!" })
            };
        }
        const isValidWifi = wifiBssid === "00:1a:2b:3c:4d:5e";
        const isValidGps = gpsLocation && gpsLocation.includes("Lat");

        if (!isValidWifi && !isValidGps) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Chấm công thất bại: Thiết bị của bạn không nằm trong vùng văn phòng!" })
            };
        }
        const timestamp = new Date().toISOString();
        const currentDate = timestamp.substring(0, 10); 
        const currentType = actionType === "OUT" ? "CHECKOUT" : "CHECKIN";
        const attendanceRecord = {
            PK: `TENANT#${tenantId}`, 
            SK: `USER#${userId}#ATTENDANCE#${currentDate}#${currentType}`,
            UserId: userId,
            Timestamp: timestamp,
            Action: currentType,
            DeviceVerified: isValidWifi ? "Wi-Fi Office" : "GPS Mobile",
            Status: "SUCCESS"
        };
        await ddbDocClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: attendanceRecord
        }));

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({ 
                message: `${currentType === "CHECKIN" ? "Check-in Vào Ca" : "Check-out Ra Ca"} thành công!`, 
                data: attendanceRecord 
            })
        };
    } catch (error) {
        console.error("Lỗi Lambda:", error);
        return { 
            statusCode: 500, 
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: error.message }) 
        };
    }
};