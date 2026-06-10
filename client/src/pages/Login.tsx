import { useState } from 'react';
import { UserSession } from '../App.tsx';

interface LoginProps {
  onLoginSuccess: (token: string, user: UserSession) => void;
}

function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please fill in all fields.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed. Please check your credentials.');
      }

      onLoginSuccess(data.token, data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      background: 'radial-gradient(circle at top, #111a36 0%, #0a0d16 100%)'
    }}>
      <div className="glass-card" style={{
        width: '100%',
        maxWidth: '420px',
        padding: '40px',
        textAlign: 'left'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <span style={{ fontSize: '3rem', display: 'block', marginBottom: '12px' }}>🏫</span>
          <h2 style={{ fontSize: '1.75rem', color: '#fff', fontWeight: '800', fontFamily: 'Outfit' }}>Welcome back</h2>
          <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: '6px' }}>
            Enter your credentials to access the AI Portal
          </p>
        </div>

        {error && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '8px',
            padding: '12px 16px',
            color: '#f87171',
            fontSize: '0.85rem',
            marginBottom: '24px',
            animation: 'fadeIn 0.2s ease'
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label className="input-label" htmlFor="email">Email Address</label>
            <input
              id="email"
              type="email"
              className="input-field"
              placeholder="e.g. admin@school.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="input-group" style={{ marginBottom: '28px' }}>
            <label className="input-label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="input-field"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', padding: '12px', fontSize: '0.95rem', fontWeight: '600' }}
            disabled={loading}
          >
            {loading ? 'Authenticating...' : 'Sign In'}
          </button>
        </form>

        <div style={{ marginTop: '24px', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.05)', fontSize: '0.75rem', color: '#64748b' }}>
          <div style={{ fontWeight: '600', color: '#94a3b8', marginBottom: '4px' }}>Demo accounts:</div>
          <div>Admin: <code>admin@school.edu</code> / <code>admin123</code></div>
          <div style={{ marginTop: '2px' }}>Teacher: <code>teacher.alice@school.edu</code> / <code>teacher123</code></div>
          <div style={{ marginTop: '2px' }}>Student: <code>student.charlie@school.edu</code> / <code>student123</code></div>
        </div>
      </div>
    </div>
  );
}

export default Login;
