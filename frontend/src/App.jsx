import { useEffect, useMemo, useState } from 'react'
import './App.css'

const initialAuthForm = {
  tenantId: '',
  userId: '',
  password: '',
  fullName: '',
  email: '',
  phone: '',
  otpType: 'PHONE',
  otpCode: '',
}

const initialAttendanceForm = {
  wifiBssid: '00:1a:2b:3c:4d:5e',
  actionType: 'IN',
}

function App() {
  const [mode, setMode] = useState('login')
  const [authForm, setAuthForm] = useState(initialAuthForm)
  const [attendanceForm, setAttendanceForm] = useState(initialAttendanceForm)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [token, setToken] = useState(() => localStorage.getItem('attendanceToken') || '')
  const [user, setUser] = useState(() => {
    const savedUser = localStorage.getItem('attendanceUser')
    return savedUser ? JSON.parse(savedUser) : null
  })
  const [history, setHistory] = useState([])
  const [reportMonth, setReportMonth] = useState(new Date().toISOString().slice(0, 7))

  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000'

  useEffect(() => {
    if (token) {
      loadHistory()
    }
  }, [token])

  const summary = useMemo(() => {
    const latest = history[0]
    return {
      total: history.length,
      latestAction: latest?.Action || 'Chưa có dữ liệu',
      latestTime: latest?.Timestamp ? new Date(latest.Timestamp).toLocaleString('vi-VN') : 'Chưa có dữ liệu',
    }
  }, [history])

  async function requestJson(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    }

    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers,
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      throw new Error(payload.message || 'Yêu cầu không thành công')
    }

    return payload
  }

  async function loadHistory() {
    try {
      const data = await requestJson('/attendance/history')
      setHistory(data.history || [])
    } catch (error) {
      setMessage(error.message)
    }
  }

  const handleFieldChange = (event) => {
    const { name, value } = event.target
    setAuthForm((current) => ({ ...current, [name]: value }))
  }

  const handleAttendanceFieldChange = (event) => {
    const { name, value } = event.target
    setAttendanceForm((current) => ({ ...current, [name]: value }))
  }

  const handleLogin = async (event) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const data = await requestJson('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: authForm.tenantId,
          userId: authForm.userId,
          password: authForm.password,
        }),
      })

      localStorage.setItem('attendanceToken', data.token)
      localStorage.setItem('attendanceUser', JSON.stringify(data.user))
      setToken(data.token)
      setUser(data.user)
      setMessage(data.message)
      setAuthForm((current) => ({ ...current, password: '' }))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRegisterRequest = async (event) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const data = await requestJson('/auth/register/request', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: authForm.tenantId,
          userId: authForm.userId,
          password: authForm.password,
          fullName: authForm.fullName,
          email: authForm.email,
          phone: authForm.phone,
          otpType: authForm.otpType,
        }),
      })
      setMessage(data.message)
      setMode('verify')
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRegisterVerify = async (event) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const data = await requestJson('/auth/register/verify', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: authForm.tenantId,
          userId: authForm.userId,
          otpCode: authForm.otpCode,
        }),
      })
      setMessage(data.message)
      setMode('login')
      setAuthForm((current) => ({ ...current, otpCode: '', password: '' }))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleCheckIn = async (event) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const data = await requestJson('/attendance/check-in', {
        method: 'POST',
        body: JSON.stringify({
          wifiBssid: attendanceForm.wifiBssid,
          actionType: attendanceForm.actionType,
        }),
      })
      setMessage(data.message)
      await loadHistory()
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleExportReport = async (event) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const response = await fetch(`${apiBaseUrl}/attendance/export/${reportMonth}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.message || 'Xuất báo cáo không thành công')
      }

      const blob = await response.blob()
      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = `BaoCao_ChamCong_${reportMonth}.xlsx`
      link.click()
      window.URL.revokeObjectURL(downloadUrl)
      setMessage(`Đã tải báo cáo ${reportMonth}`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('attendanceToken')
    localStorage.removeItem('attendanceUser')
    setToken('')
    setUser(null)
    setHistory([])
    setMessage('Đã đăng xuất khỏi hệ thống')
    setMode('login')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Smart Attendance SaaS</p>
          <h1>Quản lý chấm công và báo cáo</h1>
        </div>
        {user ? (
          <button type="button" className="secondary-btn" onClick={handleLogout}>
            Đăng xuất
          </button>
        ) : null}
      </header>

      {message ? <div className={`notice ${message.includes('thành công') || message.includes('Đã') ? 'success' : 'error'}`}>{message}</div> : null}

      {!user ? (
        <section className="card auth-card">
          <div className="auth-switch">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              Đăng nhập
            </button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
              Đăng ký
            </button>
          </div>

          {mode === 'login' ? (
            <form className="stack" onSubmit={handleLogin}>
              <h2>Đăng nhập vào hệ thống</h2>
              <label>
                Mã doanh nghiệp
                <input name="tenantId" value={authForm.tenantId} onChange={handleFieldChange} required />
              </label>
              <label>
                Tài khoản
                <input name="userId" value={authForm.userId} onChange={handleFieldChange} required />
              </label>
              <label>
                Mật khẩu
                <input type="password" name="password" value={authForm.password} onChange={handleFieldChange} required />
              </label>
              <button type="submit" disabled={loading}>{loading ? 'Đang xử lý...' : 'Đăng nhập'}</button>
            </form>
          ) : mode === 'register' ? (
            <form className="stack" onSubmit={handleRegisterRequest}>
              <h2>Đăng ký tài khoản nhân viên</h2>
              <div className="two-col">
                <label>
                  Mã doanh nghiệp
                  <input name="tenantId" value={authForm.tenantId} onChange={handleFieldChange} required />
                </label>
                <label>
                  Tài khoản
                  <input name="userId" value={authForm.userId} onChange={handleFieldChange} required />
                </label>
              </div>
              <label>
                Mật khẩu
                <input type="password" name="password" value={authForm.password} onChange={handleFieldChange} required />
              </label>
              <label>
                Họ và tên
                <input name="fullName" value={authForm.fullName} onChange={handleFieldChange} />
              </label>
              <div className="two-col">
                <label>
                  Email
                  <input type="email" name="email" value={authForm.email} onChange={handleFieldChange} required />
                </label>
                <label>
                  Số điện thoại
                  <input name="phone" value={authForm.phone} onChange={handleFieldChange} required />
                </label>
              </div>
              <label>
                Kênh OTP
                <select name="otpType" value={authForm.otpType} onChange={handleFieldChange}>
                  <option value="PHONE">SMS</option>
                  <option value="EMAIL">Email</option>
                </select>
              </label>
              <button type="submit" disabled={loading}>{loading ? 'Đang gửi OTP...' : 'Gửi mã OTP'}</button>
            </form>
          ) : (
            <form className="stack" onSubmit={handleRegisterVerify}>
              <h2>Xác thực OTP</h2>
              <p>Mã OTP đã được gửi đến kênh bạn chọn. Vui lòng nhập ở đây.</p>
              <label>
                Mã OTP
                <input name="otpCode" value={authForm.otpCode} onChange={handleFieldChange} required />
              </label>
              <button type="submit" disabled={loading}>{loading ? 'Đang xác nhận...' : 'Xác nhận'}</button>
              <button type="button" className="secondary-btn" onClick={() => setMode('register')}>
                Quay lại
              </button>
            </form>
          )}
        </section>
      ) : (
        <div className="dashboard-grid">
          <aside className="sidebar card">
            <p className="eyebrow">Thông tin người dùng</p>
            <h2>{user.fullName}</h2>
            <ul className="info-list">
              <li><span>Mã công ty</span><strong>{user.tenantId}</strong></li>
              <li><span>Tài khoản</span><strong>{user.userId}</strong></li>
            </ul>

            <div className="summary-box">
              <p>Tổng số ca được ghi nhận</p>
              <strong>{summary.total}</strong>
            </div>
            <div className="summary-box muted">
              <p>Ca gần nhất</p>
              <strong>{summary.latestAction}</strong>
              <small>{summary.latestTime}</small>
            </div>
          </aside>

          <main className="content-stack">
            <section className="card">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Chấm công</p>
                  <h2>Ghi nhận ca làm việc</h2>
                </div>
              </div>
              <form className="stack" onSubmit={handleCheckIn}>
                <label>
                  Wi-Fi văn phòng
                  <input name="wifiBssid" value={attendanceForm.wifiBssid} onChange={handleAttendanceFieldChange} />
                </label>
                <label>
                  Loại thao tác
                  <select name="actionType" value={attendanceForm.actionType} onChange={handleAttendanceFieldChange}>
                    <option value="IN">Check-in</option>
                    <option value="OUT">Check-out</option>
                  </select>
                </label>
                <button type="submit" disabled={loading}>{loading ? 'Đang ghi nhận...' : 'Gửi chấm công'}</button>
              </form>
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Lịch sử</p>
                  <h2>Nhật ký chấm công</h2>
                </div>
                <button type="button" className="secondary-btn" onClick={loadHistory}>
                  Tải lại
                </button>
              </div>
              <ul className="history-list">
                {history.length ? history.map((item, index) => (
                  <li key={`${item.Timestamp}-${index}`}>
                    <div>
                      <strong>{item.Action === 'CHECKIN' ? 'Check-in' : 'Check-out'}</strong>
                      <p>{new Date(item.Timestamp).toLocaleString('vi-VN')}</p>
                    </div>
                    <span>{item.DeviceVerified}</span>
                  </li>
                )) : <li className="empty-state">Chưa có bản ghi chấm công nào.</li>}
              </ul>
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Báo cáo</p>
                  <h2>Xuất báo cáo theo tháng</h2>
                </div>
              </div>
              <form className="inline-form" onSubmit={handleExportReport}>
                <label>
                  Tháng
                  <input type="month" value={reportMonth} onChange={(event) => setReportMonth(event.target.value)} />
                </label>
                <button type="submit" disabled={loading}>{loading ? 'Đang xuất...' : 'Xuất Excel'}</button>
              </form>
            </section>
          </main>
        </div>
      )}
    </div>
  )
}

export default App
