import { useState, useEffect } from 'react';
import Login from './pages/Login.tsx';
import Admin from './pages/Admin.tsx';
import TeacherChat from './pages/TeacherChat.tsx';
import StudentChat from './pages/StudentChat.tsx';

export interface UserSession {
  userId: string;
  name: string;
  email: string;
  role: 'admin' | 'teacher' | 'student';
  assignedClassIds?: string[];
  classId?: string;
}

function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('jwt_token'));
  const [user, setUser] = useState<UserSession | null>(null);
  const [currentPage, setCurrentPage] = useState<string>('login');
  const [loading, setLoading] = useState<boolean>(true);

  // Initialize and validate session
  useEffect(() => {
    const savedUser = localStorage.getItem('user_profile');
    const savedToken = localStorage.getItem('jwt_token');

    if (savedToken && savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser) as UserSession;
        setUser(parsedUser);
        setToken(savedToken);

        // Redirect based on role
        if (parsedUser.role === 'admin') {
          setCurrentPage('admin');
        } else if (parsedUser.role === 'teacher') {
          setCurrentPage('teacher-chat');
        } else if (parsedUser.role === 'student') {
          setCurrentPage('student-chat');
        }
      } catch (e) {
        // Clear broken cache
        localStorage.clear();
      }
    }
    setLoading(false);
  }, []);

  const handleLogin = (jwtToken: string, sessionUser: UserSession) => {
    localStorage.setItem('jwt_token', jwtToken);
    localStorage.setItem('user_profile', JSON.stringify(sessionUser));
    
    setToken(jwtToken);
    setUser(sessionUser);

    if (sessionUser.role === 'admin') {
      setCurrentPage('admin');
    } else if (sessionUser.role === 'teacher') {
      setCurrentPage('teacher-chat');
    } else if (sessionUser.role === 'student') {
      setCurrentPage('student-chat');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('user_profile');
    
    setToken(null);
    setUser(null);
    setCurrentPage('login');
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0d16' }}>
        <div style={{ color: '#6366f1', fontFamily: 'sans-serif', fontSize: '1.2rem' }}>Loading Platform...</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {token && user && (
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px 32px',
          background: 'rgba(17, 21, 36, 0.85)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          backdropFilter: 'blur(8px)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '1.8rem' }}>🏫</span>
            <div>
              <h1 style={{ fontSize: '1.25rem', fontFamily: 'Outfit', fontWeight: '700', color: '#fff', letterSpacing: '-0.02em' }}>
                School Management System
              </h1>
              <p style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Local Ollama & MCP Database Portal</p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.9rem', fontWeight: '600', color: '#fff' }}>{user.name}</div>
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '2px' }}>
                <span style={{
                  fontSize: '0.7rem',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontWeight: '700',
                  textTransform: 'uppercase',
                  background: user.role === 'admin' ? 'rgba(236, 72, 153, 0.15)' : user.role === 'teacher' ? 'rgba(99, 102, 241, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                  color: user.role === 'admin' ? '#ec4899' : user.role === 'teacher' ? '#6366f1' : '#10b981',
                  border: `1px solid ${user.role === 'admin' ? 'rgba(236, 72, 153, 0.3)' : user.role === 'teacher' ? 'rgba(99, 102, 241, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`
                }}>
                  {user.role}
                </span>
              </div>
            </div>
            <button className="btn btn-secondary" onClick={handleLogout} style={{ padding: '8px 16px', fontSize: '0.8rem' }}>
              Sign Out
            </button>
          </div>
        </header>
      )}

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {currentPage === 'login' && <Login onLoginSuccess={handleLogin} />}
        {currentPage === 'admin' && token && <Admin token={token} />}
        {currentPage === 'teacher-chat' && token && user && <TeacherChat token={token} user={user} />}
        {currentPage === 'student-chat' && token && user && <StudentChat token={token} user={user} />}
      </main>
    </div>
  );
}

export default App;
