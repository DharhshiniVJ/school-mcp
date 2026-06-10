import { useState, useRef, useEffect } from 'react';
import { UserSession } from '../App.tsx';

interface TeacherChatProps {
  token: string;
  user: UserSession;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function TeacherChat({ token, user }: TeacherChatProps) {
  const assignedClasses = user.assignedClassIds || [];
  const [selectedClassId, setSelectedClassId] = useState<string>(''); // Default to general chat
  
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: `Hello ${user.name}! I am your School Database Assistant. I can help you view and modify marks (0-100%) and run statistics for students enrolled in classes you teach.

You can select a class context from the dropdown above to focus our discussion, or keep it on "General" to ask general questions (like listing your classes).`
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const handleSendMessage = async (textToSend: string) => {
    if (!textToSend.trim() || loading) return;

    const userMessage: Message = { role: 'user', content: textToSend };
    const updatedMessages = [...messages, userMessage];
    
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          messages: updatedMessages.map(m => ({ role: m.role, content: m.content })),
          activeClassId: selectedClassId || undefined // Only pass if a class is selected
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to communicate with the gateway.');

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.content
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠ Error: ${err.message}`
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSendMessage(input);
  };

  // Add system notifications when the class context changes
  const handleClassChange = (classId: string) => {
    setSelectedClassId(classId);
    setMessages(prev => [...prev, {
      role: 'system',
      content: classId 
        ? `[System Notice] Chat context switched to class: ${classId}`
        : `[System Notice] Chat context switched to General (no class context)`
    } as any]);
  };

  return (
    <div style={{ display: 'flex', flex: 1, height: 'calc(100vh - 80px)', background: '#0a0d16' }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: '1000px',
        margin: '0 auto',
        padding: '24px',
        height: '100%'
      }}>
        {/* Chat window */}
        <div className="glass-card" style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          marginBottom: '20px'
        }}>
          {/* Header & Context Selection */}
          <div style={{
            padding: '16px 24px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(0,0,0,0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#6366f1', boxShadow: '0 0 10px #6366f1' }}></div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: '700', color: '#fff' }}>Marks Management Console</h2>
            </div>

            {/* Class Context Dropdown */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: '600' }}>CLASS CONTEXT:</label>
              <select
                value={selectedClassId}
                onChange={(e) => handleClassChange(e.target.value)}
                style={{
                  background: 'rgba(10, 13, 22, 0.8)',
                  color: '#fff',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: 'pointer'
                }}
                disabled={loading}
              >
                <option value="">General (No Context)</option>
                {assignedClasses.map(cid => (
                  <option key={cid} value={cid}>{cid}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Messages area */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            {messages.map((msg, index) => {
              const isSystem = msg.role === ('system' as any);
              
              if (isSystem) {
                return (
                  <div key={index} style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
                    <span style={{ fontSize: '0.75rem', background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)', color: '#a5b4fc', padding: '4px 12px', borderRadius: '6px', fontStyle: 'italic' }}>
                      {msg.content}
                    </span>
                  </div>
                );
              }

              return (
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
              );
            })}
            
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', animation: 'fadeIn 0.2s ease' }}>
                <div style={{
                  padding: '14px 18px',
                  borderRadius: '16px 16px 16px 4px',
                  background: 'rgba(23, 29, 50, 0.4)',
                  border: '1px dashed rgba(99, 102, 241, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <div style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: '#6366f1',
                    animation: 'pulseGlow 1.2s infinite'
                  }}></div>
                  <span style={{ fontSize: '0.85rem', color: '#818cf8', fontWeight: '500' }}>
                    Agent running database & statistical tools...
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '12px' }}>
          <input
            type="text"
            className="input-field"
            placeholder={selectedClassId ? `Ask about class ${selectedClassId} (e.g. "who has the highest marks?", "calculate stats")` : 'Ask general questions or select a class context above...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            style={{
              padding: '16px 20px',
              borderRadius: '12px',
              fontSize: '1rem'
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            style={{
              padding: '0 28px',
              borderRadius: '12px',
              fontSize: '1rem',
              fontWeight: '600'
            }}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default TeacherChat;
