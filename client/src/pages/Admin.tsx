import { useState, useEffect, useRef } from 'react';

interface AdminProps {
  token: string;
}

interface ClassModel {
  _id: string;
  name: string;
}

interface UserModel {
  _id: string;
  email: string;
  name: string;
  role: 'admin' | 'teacher' | 'student';
  classId?: string;
  assignedClassIds?: string[];
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function Admin({ token }: AdminProps) {
  // Data states
  const [users, setUsers] = useState<UserModel[]>([]);
  const [classes, setClasses] = useState<ClassModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'roster' | 'classes' | 'provision' | 'chat'>('roster');

  // Form states - Create User
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'teacher' | 'student'>('student');
  const [name, setName] = useState('');
  const [studentClassId, setStudentClassId] = useState('');
  const [teacherClasses, setTeacherClasses] = useState<string[]>([]);

  // Form states - Create Class
  const [newClassId, setNewClassId] = useState('');
  const [newClassName, setNewClassName] = useState('');

  // Form states - Dynamic Assignments
  const [assignTeacherId, setAssignTeacherId] = useState('');
  const [assignTeacherClassId, setAssignTeacherClassId] = useState('');
  const [enrollStudentId, setEnrollStudentId] = useState('');
  const [enrollStudentClassId, setEnrollStudentClassId] = useState('');

  // Chat states
  const [chatMessages, setChatMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: `Welcome to the Administrator AI Console. As an administrator, you have complete read/write access. You can ask me to:
- Create or delete classes (e.g. "Create class-art-201 named Art")
- Link teachers and students (e.g. "Assign teacher.bob@school.edu to class-english-101")
- Query raw database tables (e.g. "Show me the users collection")
- Look up marks and calculate class-wide averages.`
    }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Alerts
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (activeTab === 'chat') {
      scrollToBottom();
    }
  }, [chatMessages, chatLoading, activeTab]);

  // Load roster data
  const fetchData = async () => {
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [usersRes, classesRes] = await Promise.all([
        fetch('/api/admin/users', { headers }),
        fetch('/api/admin/classes', { headers }),
      ]);

      if (!usersRes.ok || !classesRes.ok) {
        throw new Error('Failed to retrieve dashboard records.');
      }

      const usersData = await usersRes.json();
      const classesData = await classesRes.json();

      setUsers(usersData);
      setClasses(classesData);

      // Set default dropdowns
      if (classesData.length > 0) {
        setStudentClassId(classesData[0]._id);
        setAssignTeacherClassId(classesData[0]._id);
        setEnrollStudentClassId(classesData[0]._id);
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [token]);

  const triggerAlert = (message: string, isError = false) => {
    if (isError) {
      setErrorMsg(message);
      setSuccessMsg(null);
    } else {
      setSuccessMsg(message);
      setErrorMsg(null);
    }
    setTimeout(() => {
      setSuccessMsg(null);
      setErrorMsg(null);
    }, 5000);
  };

  // 1. Handle Create User
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          userId,
          email,
          password,
          role,
          name,
          classId: role === 'student' ? studentClassId : undefined,
          assignedClassIds: role === 'teacher' ? teacherClasses : undefined
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      triggerAlert(`User "${name}" created successfully.`);
      setUserId('');
      setEmail('');
      setPassword('');
      setName('');
      setTeacherClasses([]);
      fetchData();
    } catch (err: any) {
      triggerAlert(err.message, true);
    }
  };

  // 2. Handle Create Class
  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/admin/classes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ classId: newClassId, className: newClassName })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      triggerAlert(`Class "${newClassName}" created.`);
      setNewClassId('');
      setNewClassName('');
      fetchData();
    } catch (err: any) {
      triggerAlert(err.message, true);
    }
  };

  // 3. Handle Delete Class
  const handleDeleteClass = async (classId: string) => {
    if (!confirm('Are you sure you want to delete this class? This will clean up matching marks.')) return;
    try {
      const response = await fetch(`/api/admin/classes/${classId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      triggerAlert(`Class "${classId}" deleted.`);
      fetchData();
    } catch (err: any) {
      triggerAlert(err.message, true);
    }
  };

  // 4. Handle Teacher Assignment
  const handleTeacherAssignment = async (action: 'assign' | 'unassign') => {
    if (!assignTeacherId || !assignTeacherClassId) return;
    try {
      const response = await fetch('/api/admin/assign-teacher', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          teacherId: assignTeacherId,
          classId: assignTeacherClassId,
          action
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      triggerAlert(data.message);
      fetchData();
    } catch (err: any) {
      triggerAlert(err.message, true);
    }
  };

  // 5. Handle Student Enrollment
  const handleStudentEnrollment = async (action: 'enroll' | 'unenroll') => {
    if (!enrollStudentId || !enrollStudentClassId) return;
    try {
      const response = await fetch('/api/admin/enroll-student', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          studentId: enrollStudentId,
          classId: enrollStudentClassId,
          action
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      triggerAlert(data.message);
      fetchData();
    } catch (err: any) {
      triggerAlert(err.message, true);
    }
  };

  // 6. Handle Chat Send Message (Admin AI chat)
  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    const userMsg: Message = { role: 'user', content: chatInput };
    const updatedMessages = [...chatMessages, userMsg];

    setChatMessages(updatedMessages);
    setChatInput('');
    setChatLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          messages: updatedMessages.map(m => ({ role: m.role, content: m.content }))
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to communicate with the gateway.');

      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: data.content
      }]);

      // If they created/deleted anything via chat, reload the roster in the background
      fetchData();
    } catch (err: any) {
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠ Error: ${err.message}`
      }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleTeacherClassCheckbox = (classId: string, checked: boolean) => {
    if (checked) {
      setTeacherClasses([...teacherClasses, classId]);
    } else {
      setTeacherClasses(teacherClasses.filter(id => id !== classId));
    }
  };

  const teachersList = users.filter(u => u.role === 'teacher');
  const studentsList = users.filter(u => u.role === 'student');

  return (
    <div style={{ padding: '32px', maxWidth: '1400px', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Alert Banners */}
      {successMsg && (
        <div style={{ padding: '12px 20px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', color: '#34d399', borderRadius: '8px', marginBottom: '24px', fontSize: '0.9rem' }}>
          ✓ {successMsg}
        </div>
      )}
      {errorMsg && (
        <div style={{ padding: '12px 20px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#f87171', borderRadius: '8px', marginBottom: '24px', fontSize: '0.9rem' }}>
          ⚠ {errorMsg}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '12px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '16px', marginBottom: '28px' }}>
        <button className={`btn ${activeTab === 'roster' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('roster')}>
          School Roster
        </button>
        <button className={`btn ${activeTab === 'classes' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('classes')}>
          Manage Classes
        </button>
        <button className={`btn ${activeTab === 'provision' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('provision')}>
          Provision Accounts & Link
        </button>
        <button className={`btn ${activeTab === 'chat' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('chat')}>
          AI Database Assistant
        </button>
      </div>

      {loading && activeTab !== 'chat' ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#94a3b8' }}>Updating database states...</div>
      ) : (
        <div style={{ animation: 'fadeIn 0.3s ease', display: 'flex', flex: 1, flexDirection: 'column' }}>
          {/* TAB 1: ROSTER */}
          {activeTab === 'roster' && (
            <div className="dashboard-grid">
              {/* Teachers */}
              <div className="glass-card" style={{ gridColumn: 'span 6', padding: '24px' }}>
                <h3 style={{ fontSize: '1.25rem', color: '#fff', marginBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                  Teachers ({teachersList.length})
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {teachersList.map(t => (
                    <div key={t._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }}>
                      <div>
                        <div style={{ fontWeight: '600', color: '#fff' }}>{t.name}</div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{t.email} (ID: {t._id})</div>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxWidth: '200px', justifyContent: 'flex-end' }}>
                        {t.assignedClassIds && t.assignedClassIds.length > 0 ? (
                          t.assignedClassIds.map(cid => (
                            <span key={cid} style={{ fontSize: '0.65rem', background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', border: '1px solid rgba(99, 102, 241, 0.3)', padding: '2px 6px', borderRadius: '4px' }}>
                              {cid}
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: '0.65rem', color: '#64748b', fontStyle: 'italic' }}>Unassigned</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {teachersList.length === 0 && <p style={{ color: '#64748b', fontStyle: 'italic' }}>No teachers registered.</p>}
                </div>
              </div>

              {/* Students */}
              <div className="glass-card" style={{ gridColumn: 'span 6', padding: '24px' }}>
                <h3 style={{ fontSize: '1.25rem', color: '#fff', marginBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                  Students ({studentsList.length})
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {studentsList.map(s => (
                    <div key={s._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)' }}>
                      <div>
                        <div style={{ fontWeight: '600', color: '#fff' }}>{s.name}</div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{s.email} (ID: {s._id})</div>
                      </div>
                      <div>
                        {s.classId ? (
                          <span style={{ fontSize: '0.65rem', background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)', padding: '2px 6px', borderRadius: '4px' }}>
                            {s.classId}
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.65rem', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.2)', padding: '2px 6px', borderRadius: '4px', fontStyle: 'italic' }}>
                            Not Enrolled
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {studentsList.length === 0 && <p style={{ color: '#64748b', fontStyle: 'italic' }}>No students registered.</p>}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: CLASSES */}
          {activeTab === 'classes' && (
            <div className="dashboard-grid">
              {/* Classes list */}
              <div className="glass-card" style={{ gridColumn: 'span 7', padding: '24px' }}>
                <h3 style={{ fontSize: '1.25rem', color: '#fff', marginBottom: '16px' }}>Existing Classes</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  {classes.map(c => {
                    const classTeacher = teachersList.find(t => t.assignedClassIds?.includes(c._id));
                    const enrolledCount = studentsList.filter(s => s.classId === c._id).length;

                    return (
                      <div key={c._id} className="glass-card" style={{ background: 'rgba(255,255,255,0.01)', padding: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '120px' }}>
                        <div>
                          <div style={{ fontSize: '0.75rem', color: '#6366f1', fontWeight: '700' }}>{c._id}</div>
                          <div style={{ fontSize: '1.05rem', fontWeight: '700', color: '#fff', marginTop: '2px' }}>{c.name}</div>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '6px' }}>
                            👨‍🏫 Teacher: {classTeacher ? classTeacher.name : <span style={{ fontStyle: 'italic', color: '#64748b' }}>None</span>}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '2px' }}>
                            👥 Enrolled: {enrolledCount} {enrolledCount === 1 ? 'student' : 'students'}
                          </div>
                        </div>
                        <button className="btn btn-danger" onClick={() => handleDeleteClass(c._id)} style={{ alignSelf: 'flex-end', padding: '4px 10px', fontSize: '0.7rem', marginTop: '12px' }}>
                          Remove
                        </button>
                      </div>
                    );
                  })}
                  {classes.length === 0 && <p style={{ color: '#64748b', fontStyle: 'italic', gridColumn: 'span 2' }}>No classes registered.</p>}
                </div>
              </div>

              {/* Create Class Card */}
              <div className="glass-card" style={{ gridColumn: 'span 5', padding: '24px', alignSelf: 'flex-start' }}>
                <h3 style={{ fontSize: '1.25rem', color: '#fff', marginBottom: '20px' }}>Create New Class</h3>
                <form onSubmit={handleCreateClass}>
                  <div className="input-group">
                    <label className="input-label">Class Code/ID</label>
                    <input className="input-field" placeholder="e.g. class-history-101" value={newClassId} onChange={e => setNewClassId(e.target.value)} required />
                  </div>
                  <div className="input-group" style={{ marginBottom: '24px' }}>
                    <label className="input-label">Class Name</label>
                    <input className="input-field" placeholder="e.g. History 101" value={newClassName} onChange={e => setNewClassName(e.target.value)} required />
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                    Create Class Room
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* TAB 3: PROVISION ACCOUNTS & LINK */}
          {activeTab === 'provision' && (
            <div className="dashboard-grid">
              {/* Create Account Form */}
              <div className="glass-card" style={{ gridColumn: 'span 7', padding: '24px' }}>
                <h3 style={{ fontSize: '1.25rem', color: '#fff', marginBottom: '20px' }}>Create User Account</h3>
                <form onSubmit={handleCreateUser}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <div className="input-group">
                      <label className="input-label">User ID (Unique Code)</label>
                      <input className="input-field" placeholder="e.g. user-teacher-diya" value={userId} onChange={e => setUserId(e.target.value)} required />
                    </div>
                    <div className="input-group">
                      <label className="input-label">Display Name</label>
                      <input className="input-field" placeholder="e.g. Diya Sen" value={name} onChange={e => setName(e.target.value)} required />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <div className="input-group">
                      <label className="input-label">Email Address</label>
                      <input className="input-field" type="email" placeholder="e.g. diya@school.edu" value={email} onChange={e => setEmail(e.target.value)} required />
                    </div>
                    <div className="input-group">
                      <label className="input-label">Temporary Password</label>
                      <input className="input-field" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required />
                    </div>
                  </div>

                  <div className="input-group">
                    <label className="input-label">System Role</label>
                    <select className="input-field" value={role} onChange={e => setRole(e.target.value as any)} style={{ background: '#0a0d16' }}>
                      <option value="student">Student</option>
                      <option value="teacher">Teacher</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </div>

                  {role === 'student' && (
                    <div className="input-group" style={{ animation: 'fadeIn 0.2s ease' }}>
                      <label className="input-label">Enroll In Class</label>
                      <select className="input-field" value={studentClassId} onChange={e => setStudentClassId(e.target.value)} style={{ background: '#0a0d16' }}>
                        {classes.map(c => (
                          <option key={c._id} value={c._id}>{c.name} ({c._id})</option>
                        ))}
                        {classes.length === 0 && <option value="">No classes available</option>}
                      </select>
                    </div>
                  )}

                  {role === 'teacher' && (
                    <div className="input-group" style={{ animation: 'fadeIn 0.2s ease' }}>
                      <label className="input-label">Assign Classes (Taught by this Teacher)</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', background: 'rgba(0,0,0,0.15)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        {classes.map(c => (
                          <label key={c._id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: '#94a3b8', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={teacherClasses.includes(c._id)}
                              onChange={e => handleTeacherClassCheckbox(c._id, e.target.checked)}
                              style={{ width: '16px', height: '16px', accentColor: '#6366f1' }}
                            />
                            {c.name}
                          </label>
                        ))}
                        {classes.length === 0 && <p style={{ color: '#64748b', fontStyle: 'italic', fontSize: '0.8rem' }}>No classes available</p>}
                      </div>
                    </div>
                  )}

                  <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '16px' }}>
                    Provision User Profile
                  </button>
                </form>
              </div>

              {/* Assignment Quick Actions */}
              <div style={{ gridColumn: 'span 5', display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div className="glass-card" style={{ padding: '24px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: '#fff', marginBottom: '16px' }}>Assign Teacher to Class</h3>
                  <div className="input-group">
                    <label className="input-label">Select Teacher</label>
                    <select className="input-field" value={assignTeacherId} onChange={e => setAssignTeacherId(e.target.value)} style={{ background: '#0a0d16' }}>
                      <option value="">-- Choose Teacher --</option>
                      {teachersList.map(t => (
                        <option key={t._id} value={t._id}>{t.name} ({t._id})</option>
                      ))}
                    </select>
                  </div>
                  <div className="input-group" style={{ marginBottom: '20px' }}>
                    <label className="input-label">Select Class</label>
                    <select className="input-field" value={assignTeacherClassId} onChange={e => setAssignTeacherClassId(e.target.value)} style={{ background: '#0a0d16' }}>
                      {classes.map(c => (
                        <option key={c._id} value={c._id}>{c.name} ({c._id})</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <button className="btn btn-primary" onClick={() => handleTeacherAssignment('assign')} style={{ flex: 1, padding: '8px 12px', fontSize: '0.8rem' }} disabled={!assignTeacherId}>
                      Assign
                    </button>
                    <button className="btn btn-secondary" onClick={() => handleTeacherAssignment('unassign')} style={{ flex: 1, padding: '8px 12px', fontSize: '0.8rem' }} disabled={!assignTeacherId}>
                      Unassign
                    </button>
                  </div>
                </div>

                <div className="glass-card" style={{ padding: '24px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: '#fff', marginBottom: '16px' }}>Enroll Student in Class</h3>
                  <div className="input-group">
                    <label className="input-label">Select Student</label>
                    <select className="input-field" value={enrollStudentId} onChange={e => setEnrollStudentId(e.target.value)} style={{ background: '#0a0d16' }}>
                      <option value="">-- Choose Student --</option>
                      {studentsList.map(s => (
                        <option key={s._id} value={s._id}>{s.name} ({s._id})</option>
                      ))}
                    </select>
                  </div>
                  <div className="input-group" style={{ marginBottom: '20px' }}>
                    <label className="input-label">Select Class</label>
                    <select className="input-field" value={enrollStudentClassId} onChange={e => setEnrollStudentClassId(e.target.value)} style={{ background: '#0a0d16' }}>
                      {classes.map(c => (
                        <option key={c._id} value={c._id}>{c.name} ({c._id})</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <button className="btn btn-primary" onClick={() => handleStudentEnrollment('enroll')} style={{ flex: 1, padding: '8px 12px', fontSize: '0.8rem' }} disabled={!enrollStudentId}>
                      Enroll
                    </button>
                    <button className="btn btn-secondary" onClick={() => handleStudentEnrollment('unenroll')} style={{ flex: 1, padding: '8px 12px', fontSize: '0.8rem' }} disabled={!enrollStudentId}>
                      Unenroll
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: CHAT */}
          {activeTab === 'chat' && (
            <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '600px', overflow: 'hidden' }}>
              <div style={{
                padding: '16px 24px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                background: 'rgba(0,0,0,0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ec4899', boxShadow: '0 0 10px #ec4899' }}></div>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: '700', color: '#fff' }}>Admin Global Database Orchestrator</h2>
                </div>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', background: 'rgba(255,255,255,0.04)', padding: '4px 10px', borderRadius: '4px' }}>
                  System Root Access
                </span>
              </div>

              {/* Message flow */}
              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px'
              }}>
                {chatMessages.map((msg, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                      animation: 'fadeIn 0.25s ease'
                    }}
                  >
                    <div style={{
                      maxWidth: '75%',
                      padding: '14px 18px',
                      borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      background: msg.role === 'user' ? 'var(--accent-primary)' : 'rgba(23, 29, 50, 0.7)',
                      border: msg.role === 'user' ? 'none' : '1px solid rgba(255,255,255,0.06)',
                      color: '#fff',
                      boxShadow: msg.role === 'user' ? '0 4px 12px rgba(99, 102, 241, 0.25)' : 'none'
                    }}>
                      <div style={{
                        fontSize: '0.7rem',
                        fontWeight: '700',
                        color: msg.role === 'user' ? 'rgba(255,255,255,0.7)' : 'var(--text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        marginBottom: '6px'
                      }}>
                        {msg.role === 'user' ? 'You' : 'AI Assistant'}
                      </div>
                      <div style={{
                        fontSize: '0.95rem',
                        lineHeight: '1.5',
                        whiteSpace: 'pre-wrap',
                        fontFamily: msg.content.startsWith('`') || msg.content.startsWith('{') ? 'monospace' : 'inherit'
                      }}>
                        {msg.content}
                      </div>
                    </div>
                  </div>
                ))}
                
                {chatLoading && (
                  <div style={{ display: 'flex', justifyContent: 'flex-start', animation: 'fadeIn 0.2s ease' }}>
                    <div style={{
                      padding: '14px 18px',
                      borderRadius: '16px 16px 16px 4px',
                      background: 'rgba(23, 29, 50, 0.4)',
                      border: '1px dashed rgba(236, 72, 153, 0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      <div style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: '#ec4899',
                        animation: 'pulseGlow 1.2s infinite'
                      }}></div>
                      <span style={{ fontSize: '0.85rem', color: '#f472b6', fontWeight: '500' }}>
                        Admin Agent executing root tools...
                      </span>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Chat Input form */}
              <form onSubmit={handleSendChatMessage} style={{ display: 'flex', gap: '12px', padding: '16px 24px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Ask AI to query any table, create classes, or link teacher/students..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  disabled={chatLoading}
                  style={{
                    padding: '12px 18px',
                    borderRadius: '8px',
                    fontSize: '0.95rem'
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{
                    padding: '0 24px',
                    borderRadius: '8px',
                    fontSize: '0.95rem',
                    fontWeight: '600'
                  }}
                  disabled={chatLoading || !chatInput.trim()}
                >
                  Send
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Admin;
