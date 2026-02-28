import { useState, useEffect } from 'react';
import Select from 'react-select';

const API_BASE = '';

// Common tags
const COMMON_TAGS = ['#urgent', '#quick', '#blocked', '#research', '#design', '#dev', '#review', '#docs', '#bug', '#feature'];

// Custom styles for react-select to match our dark theme
const selectStyles = {
  control: (base, state) => ({
    ...base,
    background: '#334155',
    borderColor: state.isFocused ? '#3b82f6' : '#475569',
    boxShadow: 'none',
    '&:hover': { borderColor: '#64748b' },
    minHeight: '42px',
  }),
  menu: (base) => ({
    ...base,
    background: '#334155',
    border: '1px solid #475569',
    zIndex: 20,
  }),
  option: (base, state) => ({
    ...base,
    background: state.isSelected ? '#3b82f6' : state.isFocused ? '#475569' : 'transparent',
    color: '#e2e8f0',
    cursor: 'pointer',
    '&:active': { background: '#3b82f6' },
  }),
  multiValue: (base) => ({
    ...base,
    background: '#3b82f6',
    borderRadius: '4px',
  }),
  multiValueLabel: (base) => ({
    ...base,
    color: 'white',
    padding: '2px 6px',
  }),
  multiValueRemove: (base) => ({
    ...base,
    color: 'white',
    '&:hover': { background: '#2563eb', color: 'white' },
  }),
  singleValue: (base) => ({
    ...base,
    color: '#e2e8f0',
  }),
  input: (base) => ({
    ...base,
    color: '#e2e8f0',
  }),
  placeholder: (base) => ({
    ...base,
    color: '#64748b',
  }),
  indicatorSeparator: () => ({ display: 'none' }),
  dropdownIndicator: (base) => ({
    ...base,
    color: '#64748b',
    '&:hover': { color: '#94a3b8' },
  }),
};

function TaskModal({ task, columnTitle, projects, activeProjects, onSave, onDelete, onClose }) {
  // Start in view mode if editing existing task, edit mode if creating new
  const [isEditing, setIsEditing] = useState(!task);
  
  const [title, setTitle] = useState(task?.title || '');
  const [priority, setPriority] = useState(task?.metadata?.priority || 'P2');
  const [selectedProject, setSelectedProject] = useState(task?._project || activeProjects?.[0] || '');
  const [assignedUsers, setAssignedUsers] = useState([]);
  const [creator, setCreator] = useState(task?.metadata?.creator || 'Fran');
  const [selectedTags, setSelectedTags] = useState(() => {
    const existing = task?.metadata?.tags || '';
    return existing ? existing.split(' ').filter(t => t) : [];
  });
  const [customTag, setCustomTag] = useState('');
  const [description, setDescription] = useState(
    task?.body?.filter(l => !l.startsWith('**')).join('\n') || ''
  );
  
  // Dynamic data
  const [availableUsers, setAvailableUsers] = useState([]);
  const [projectUsers, setProjectUsers] = useState({});
  const [loading, setLoading] = useState(true);

  // Fetch users with project access on mount
  useEffect(() => {
    fetchProjectUsers();
  }, []);

  // Update assigned users when project changes
  useEffect(() => {
    if (!loading && selectedProject && projectUsers[selectedProject]) {
      const validUserIds = projectUsers[selectedProject].map(u => u.id);
      setAssignedUsers(prev => prev.filter(u => u.value === 'anyone' || validUserIds.includes(u.value)));
    }
  }, [selectedProject, projectUsers, loading]);

  async function fetchProjectUsers() {
    try {
      const usersRes = await fetch(`${API_BASE}/api/users`, { credentials: 'include' });
      let allUsers = [];
      if (usersRes.ok) {
        const data = await usersRes.json();
        allUsers = Object.entries(data.users).map(([id, user]) => ({
          id,
          name: user.name
        }));
      }
      setAvailableUsers(allUsers);

      const projectUserMap = {};
      for (const projectId of Object.keys(projects || {})) {
        try {
          const permRes = await fetch(`${API_BASE}/api/projects/${projectId}/permissions`, { 
            credentials: 'include' 
          });
          if (permRes.ok) {
            const permData = await permRes.json();
            projectUserMap[projectId] = Object.entries(permData.permissions).map(([userId, info]) => ({
              id: userId,
              name: info.name || userId,
              permission: info.permission
            }));
          }
        } catch (e) {
          projectUserMap[projectId] = allUsers;
        }
      }
      setProjectUsers(projectUserMap);

      // Set initial assigned users
      const existing = task?.metadata?.assigned || '';
      if (existing && existing !== 'Anyone') {
        const names = existing.split(',').map(s => s.trim());
        const matched = allUsers.filter(u => names.some(n => 
          n.toLowerCase() === u.name.toLowerCase() || n.toLowerCase().replace('@', '') === u.id
        ));
        setAssignedUsers(matched.map(u => ({ value: u.id, label: u.name })));
      }
      
      setLoading(false);
    } catch (err) {
      console.error('Failed to fetch users:', err);
      setLoading(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    
    let assignedStr = '';
    if (assignedUsers.length === 0 || assignedUsers.some(u => u.value === 'anyone')) {
      assignedStr = 'Anyone';
    } else {
      assignedStr = assignedUsers.map(u => u.label).join(', ');
    }
    
    onSave({
      title,
      priority,
      project: selectedProject,
      assigned: assignedStr,
      creator,
      tags: selectedTags.join(' '),
      description
    });
  }

  function toggleTag(tag) {
    setSelectedTags(prev => {
      if (prev.includes(tag)) {
        return prev.filter(t => t !== tag);
      }
      return [...prev, tag];
    });
  }

  function addCustomTag() {
    if (!customTag) return;
    const tag = customTag.startsWith('#') ? customTag : `#${customTag}`;
    if (!selectedTags.includes(tag)) {
      setSelectedTags(prev => [...prev, tag]);
    }
    setCustomTag('');
  }

  const currentProjectUsers = projectUsers[selectedProject] || availableUsers;
  const userOptions = [
    { value: 'anyone', label: 'Anyone' },
    ...currentProjectUsers.map(u => ({ value: u.id, label: u.name }))
  ];
  const creatorOptions = currentProjectUsers.map(u => ({ value: u.name, label: u.name }));
  const projectList = projects ? Object.entries(projects) : [];

  // Build display ID
  const projectName = task?._projectName || projects?.[selectedProject]?.name || selectedProject;
  const displayId = task ? `${projectName.toUpperCase()}-${task.id.replace('TASK-', '')}` : null;

  // View mode render
  if (!isEditing && task) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal task-view-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{displayId}</h2>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
          
          <div className="task-view-content">
            <h3 className="task-view-title">{title}</h3>
            
            <div className="task-view-meta">
              <div className="meta-item">
                <span className="meta-label">Priority</span>
                <span className={`meta-value priority-${priority}`}>{priority}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Project</span>
                <span className="meta-value">{projectName}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Assigned</span>
                <span className="meta-value">{task.metadata?.assigned || 'Anyone'}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Creator</span>
                <span className="meta-value">{creator}</span>
              </div>
            </div>
            
            {selectedTags.length > 0 && (
              <div className="task-view-tags">
                {selectedTags.map(tag => (
                  <span key={tag} className="tag-chip selected">{tag}</span>
                ))}
              </div>
            )}
            
            {description && (
              <div className="task-view-description">
                <span className="meta-label">Description</span>
                <div className="description-content">{description}</div>
              </div>
            )}
            
            {task.metadata?.history && task.metadata.history.length > 0 && (
              <div className="task-view-history">
                <span className="meta-label">Activity</span>
                <div className="history-list">
                  {task.metadata.history.map((entry, i) => {
                    const [timestamp, ...rest] = entry.split(' | ');
                    const action = rest.join(' | ');
                    return (
                      <div key={i} className="history-entry">
                        <span className="history-time">{timestamp}</span>
                        <span className="history-action">{action}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          
          <div className="modal-actions">
            {onDelete && (
              <button type="button" className="delete-btn" onClick={onDelete}>
                Delete
              </button>
            )}
            <div className="spacer" />
            <button type="button" className="cancel-btn" onClick={onClose}>
              Close
            </button>
            <button type="button" className="save-btn" onClick={() => setIsEditing(true)}>
              ✏️ Edit
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Edit/Create mode render
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{task ? `Edit ${displayId}` : `New Task in ${columnTitle}`}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Task title"
              required
              autoFocus
            />
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>Priority</label>
              <select value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="P0">P0 - Critical</option>
                <option value="P1">P1 - High</option>
                <option value="P2">P2 - Medium</option>
                <option value="P3">P3 - Low</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Project</label>
              <select 
                value={selectedProject} 
                onChange={e => setSelectedProject(e.target.value)}
                disabled={!!task}
              >
                {projectList.map(([id, proj]) => (
                  <option key={id} value={id}>{proj.name}</option>
                ))}
              </select>
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>Assigned</label>
              <Select
                isMulti
                options={userOptions}
                value={assignedUsers}
                onChange={(selected) => {
                  if (selected?.some(s => s.value === 'anyone')) {
                    if (assignedUsers.some(u => u.value === 'anyone')) {
                      setAssignedUsers(selected.filter(s => s.value !== 'anyone'));
                    } else {
                      setAssignedUsers([{ value: 'anyone', label: 'Anyone' }]);
                    }
                  } else {
                    setAssignedUsers(selected || []);
                  }
                }}
                styles={selectStyles}
                placeholder="Select assignees..."
                isLoading={loading}
                classNamePrefix="react-select"
              />
            </div>
            
            <div className="form-group">
              <label>Creator</label>
              <Select
                options={creatorOptions}
                value={creatorOptions.find(o => o.value === creator) || { value: creator, label: creator }}
                onChange={(selected) => setCreator(selected?.value || 'Fran')}
                styles={selectStyles}
                placeholder="Select creator..."
                isLoading={loading}
                classNamePrefix="react-select"
              />
            </div>
          </div>
          
          <div className="form-group">
            <label>Tags</label>
            <div className="tag-cloud">
              {COMMON_TAGS.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className={`tag-chip ${selectedTags.includes(tag) ? 'selected' : ''}`}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
            <div className="custom-tag-input">
              <input
                type="text"
                value={customTag}
                onChange={e => setCustomTag(e.target.value)}
                placeholder="Add custom tag..."
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustomTag();
                  }
                }}
              />
              <button type="button" onClick={addCustomTag}>+</button>
            </div>
            {selectedTags.filter(t => !COMMON_TAGS.includes(t)).length > 0 && (
              <div className="selected-custom-tags">
                {selectedTags.filter(t => !COMMON_TAGS.includes(t)).map(tag => (
                  <span key={tag} className="tag-chip selected" onClick={() => toggleTag(tag)}>
                    {tag} ×
                  </span>
                ))}
              </div>
            )}
          </div>
          
          <div className="form-group">
            <label>Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What needs to be done..."
              rows={8}
            />
          </div>
          
          <div className="modal-actions">
            {onDelete && (
              <button type="button" className="delete-btn" onClick={onDelete}>
                Delete
              </button>
            )}
            <div className="spacer" />
            {task && (
              <button type="button" className="cancel-btn" onClick={() => setIsEditing(false)}>
                Cancel
              </button>
            )}
            {!task && (
              <button type="button" className="cancel-btn" onClick={onClose}>
                Cancel
              </button>
            )}
            <button type="submit" className="save-btn">
              {task ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TaskModal;
