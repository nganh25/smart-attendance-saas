exports.handler = async (event) => {
   
    console.log("Da nhan duoc request tu API Gateway!");

   
    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" 
        },
        body: JSON.stringify({
            message: "Hello team! Hạ tầng Cloud Serverless đã được kết nối thành công!",
            thoi_gian: new Date().toISOString()
        }),
    };
};