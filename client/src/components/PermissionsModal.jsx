import { useState, useEffect } from 'react';

const API_BASE = '';

function PermissionsModal({ onClose, onProjectsChange }) {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState({});
  const [projects, setProjects] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Selected items for card view
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  
  // Create forms
  const [newUser, setNewUser] = useState({ id: '', name: '', email: '' });
  const [newProject, setNewProject] = useState({ id: '', name: '' });
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  
  // Magic link
  const [magicLink, setMagicLink] = useState(null);
  const [magicLinkUser, setMagicLinkUser] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    // Auto-select first user/project when data loads
    const userIds = Object.keys(users);
    const projectIds = Object.keys(projects);
    if (!selectedUser && userIds.length) setSelectedUser(userIds[0]);
    if (!selectedProject && projectIds.length) setSelectedProject(projectIds[0]);
  }, [users, projects]);

  async function fetchData() {
    setLoading(true);
    try {
      const [usersRes, projectsRes] = await Promise.all([
        fetch(`${API_BASE}/api/users`, { credentials: 'include' }),
        fetch(`${API_BASE}/api/projects`, { credentials: 'include' })
      ]);
      
      if (usersRes.ok) setUsers((await usersRes.json()).users);
      if (projectsRes.ok) setProjects((await projectsRes.json()).projects);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    setError(null);
    
    try {
      const res = await fetch(`${API_BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(newUser)
      });
      
      const data = await res.json();
      
      if (res.ok) {
        setMagicLink(data.magicLink);
        setMagicLinkUser(newUser.name);
        setNewUser({ id: '', name: '', email: '' });
        setShowCreateUser(false);
        fetchData();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegenerateToken(userId) {
    try {
      const res = await fetch(`${API_BASE}/api/users/${userId}/token`, {
        method: 'POST',
        credentials: 'include'
      });
      
      const data = await res.json();
      if (res.ok) {
        setMagicLink(data.magicLink);
        setMagicLinkUser(users[userId]?.name || userId);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeleteUser(userId) {
    if (!confirm(`Delete user ${userId}?`)) return;
    
    try {
      await fetch(`${API_BASE}/api/users/${userId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      setSelectedUser(null);
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCreateProject(e) {
    e.preventDefault();
    setError(null);
    
    try {
      const res = await fetch(`${API_BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(newProject)
      });
      
      const data = await res.json();
      
      if (res.ok) {
        setNewProject({ id: '', name: '' });
        setShowCreateProject(false);
        fetchData();
        onProjectsChange?.();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) {
    return (
      <div className="modal-overlay">
        <div className="modal settings-modal">
          <p style={{ textAlign: 'center', padding: '40px' }}>Loading...</p>
        </div>
      </div>
    );
  }

  const userList = Object.entries(users);
  const projectList = Object.entries(projects);
  const currentUser = selectedUser ? users[selectedUser] : null;
  const currentProject = selectedProject ? projects[selectedProject] : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>⚙️ Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div className="settings-tabs">
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            👤 Users
          </button>
          <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
            📁 Projects
          </button>
          <button className={tab === 'permissions' ? 'active' : ''} onClick={() => setTab('permissions')}>
            🔒 Access
          </button>
        </div>

        {error && <div className="settings-error">{error}</div>}

        <div className="settings-content">
          {/* Users Tab */}
          {tab === 'users' && (
            <div className="settings-section">
              <div className="section-header">
                <select 
                  value={selectedUser || ''} 
                  onChange={e => setSelectedUser(e.target.value)}
                  className="item-select"
                >
                  {userList.map(([id, user]) => (
                    <option key={id} value={id}>{user.name}</option>
                  ))}
                </select>
                <button 
                  className="add-btn" 
                  onClick={() => setShowCreateUser(!showCreateUser)}
                >
                  {showCreateUser ? '✕' : '+'}
                </button>
              </div>

              {showCreateUser && (
                <form onSubmit={handleCreateUser} className="create-card">
                  <h4>New User</h4>
                  <input
                    type="text"
                    placeholder="ID (e.g., pierre)"
                    value={newUser.id}
                    onChange={e => setNewUser({ ...newUser, id: e.target.value })}
                    required
                  />
                  <input
                    type="text"
                    placeholder="Name"
                    value={newUser.name}
                    onChange={e => setNewUser({ ...newUser, name: e.target.value })}
                    required
                  />
                  <input
                    type="email"
                    placeholder="Email (optional)"
                    value={newUser.email}
                    onChange={e => setNewUser({ ...newUser, email: e.target.value })}
                  />
                  <button type="submit" className="btn-primary">Create User</button>
                </form>
              )}

              {currentUser && !showCreateUser && (
                <div className="detail-card">
                  <div className="card-row">
                    <span className="label">ID</span>
                    <span className="value">{selectedUser}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Name</span>
                    <span className="value">{currentUser.name}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Email</span>
                    <span className="value">{currentUser.email || '—'}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Role</span>
                    <span className={`badge ${currentUser.role}`}>{currentUser.role || 'user'}</span>
                  </div>
                  
                  <div className="card-actions">
                    <button className="btn-secondary" onClick={() => handleRegenerateToken(selectedUser)}>
                      🔗 New Magic Link
                    </button>
                    {currentUser.role !== 'admin' && (
                      <button className="btn-danger" onClick={() => handleDeleteUser(selectedUser)}>
                        🗑️ Delete
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Projects Tab */}
          {tab === 'projects' && (
            <div className="settings-section">
              <div className="section-header">
                <select 
                  value={selectedProject || ''} 
                  onChange={e => setSelectedProject(e.target.value)}
                  className="item-select"
                >
                  {projectList.map(([id, proj]) => (
                    <option key={id} value={id}>{proj.name}</option>
                  ))}
                </select>
                <button 
                  className="add-btn" 
                  onClick={() => setShowCreateProject(!showCreateProject)}
                >
                  {showCreateProject ? '✕' : '+'}
                </button>
              </div>

              {showCreateProject && (
                <form onSubmit={handleCreateProject} className="create-card">
                  <h4>New Project</h4>
                  <input
                    type="text"
                    placeholder="ID (e.g., supstrategy)"
                    value={newProject.id}
                    onChange={e => setNewProject({ ...newProject, id: e.target.value })}
                    required
                  />
                  <input
                    type="text"
                    placeholder="Display Name"
                    value={newProject.name}
                    onChange={e => setNewProject({ ...newProject, name: e.target.value })}
                    required
                  />
                  <button type="submit" className="btn-primary">Create Project</button>
                </form>
              )}

              {currentProject && !showCreateProject && (
                <div className="detail-card">
                  <div className="card-row">
                    <span className="label">ID</span>
                    <span className="value">{selectedProject}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Name</span>
                    <span className="value">{currentProject.name}</span>
                  </div>
                  <div className="card-row">
                    <span className="label">Your Access</span>
                    <span className={`badge ${currentProject.permission}`}>
                      {currentProject.permission}
                      {currentProject.isOwner && ' (owner)'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Permissions Tab */}
          {tab === 'permissions' && (
            <div className="settings-section">
              <div className="section-header">
                <select 
                  value={selectedProject || ''} 
                  onChange={e => setSelectedProject(e.target.value)}
                  className="item-select"
                >
                  {projectList.map(([id, proj]) => (
                    <option key={id} value={id}>{proj.name}</option>
                  ))}
                </select>
              </div>

              {selectedProject && (
                <div className="permissions-list">
                  <p className="hint">Set access level for each user</p>
                  {userList.map(([userId, user]) => (
                    <PermissionRow 
                      key={userId}
                      projectId={selectedProject}
                      userId={userId}
                      userName={user.name}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Magic Link Display */}
        {magicLink && (
          <div className="magic-link-card">
            <p>🔗 Magic Link for <strong>{magicLinkUser}</strong></p>
            <input 
              type="text" 
              value={magicLink} 
              readOnly 
              onClick={e => e.target.select()} 
            />
            <div className="magic-link-actions">
              <button 
                className="btn-primary"
                onClick={() => {
                  navigator.clipboard.writeText(magicLink);
                  setMagicLink(null);
                  setMagicLinkUser(null);
                }}
              >
                📋 Copy & Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Row component for permission editing
function PermissionRow({ projectId, userId, userName }) {
  const [permission, setPermission] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function fetchPermission() {
      try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/permissions`, {
          credentials: 'include'
        });
        if (res.ok) {
          const data = await res.json();
          setPermission(data.permissions[userId]?.permission || '');
        }
      } catch (err) {
        console.error(err);
      }
      setLoading(false);
    }
    fetchPermission();
  }, [projectId, userId]);

  async function handleChange(newPermission) {
    setSaving(true);
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/permissions/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ permission: newPermission || null })
      });
      setPermission(newPermission);
    } catch (err) {
      console.error(err);
    }
    setSaving(false);
  }

  return (
    <div className="permission-row">
      <span className="user-name">{userName}</span>
      <select
        value={permission}
        onChange={e => handleChange(e.target.value)}
        disabled={loading || saving}
        className={`permission-select ${permission || 'none'}`}
      >
        <option value="">None</option>
        <option value="viewer">Viewer</option>
        <option value="editor">Editor</option>
        <option value="admin">Admin</option>
      </select>
    </div>
  );
}

export default PermissionsModal;
