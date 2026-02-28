import { useState, useEffect } from 'react';

const API_BASE = '';

export default function BriefPanel({ projects, activeProjects, user, isOpen, isMobile, onClose }) {
  const [content, setContent] = useState('');
  const [exists, setExists] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Use the active project (single select now)
  const selectedProject = activeProjects[0];
  const projectName = projects[selectedProject]?.name || selectedProject;

  useEffect(() => {
    if (selectedProject && projects[selectedProject]) {
      fetchBrief();
      setEditing(false); // Reset editing when project changes
    }
  }, [selectedProject]);

  async function fetchBrief() {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${selectedProject}/brief`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setContent(data.content || '');
        setExists(data.exists);
      } else {
        const err = await res.json();
        setError(err.error || 'Failed to load brief');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${selectedProject}/brief`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (res.ok) {
        setExists(true);
        setEditing(false);
      } else {
        const err = await res.json();
        setError(err.error || 'Failed to save brief');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // Simple markdown to HTML
  function renderMarkdown(md) {
    if (!md) return '<p class="empty-brief">No brief yet</p>';
    
    return md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      .split('\n\n')
      .map(p => {
        if (p.startsWith('<') || p.trim() === '') return p;
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');
  }

  const canEdit = projects[selectedProject]?.permission === 'editor' || 
                  projects[selectedProject]?.permission === 'admin' || 
                  user?.role === 'admin';

  // Build class name for mobile drawer
  const panelClass = isMobile 
    ? `brief-panel ${isOpen ? 'open' : ''}`
    : 'brief-panel';

  if (!selectedProject) {
    return null;
  }

  return (
    <div className={panelClass}>
      {isMobile && (
        <div className="brief-header">
          <button onClick={onClose} className="drawer-close" title="Close">
            ✕
          </button>
        </div>
      )}

      {error && <div className="brief-error">{error}</div>}

      <div className="brief-content">
        {canEdit && !editing && (
          <button 
            onClick={() => setEditing(true)} 
            className="btn-icon brief-edit-floating" 
            title="Edit"
          >
            ✏️
          </button>
        )}
        {editing ? (
          <>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              className="brief-editor"
              placeholder="# Project Name&#10;&#10;> Description&#10;&#10;## Resources&#10;- **Domain**: example.com"
            />
            <div className="brief-editor-actions">
              <button onClick={() => { setEditing(false); fetchBrief(); }} className="btn-secondary">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="btn-primary">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <div 
            className="brief-preview markdown-content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
      </div>

      {!exists && !editing && (
        <div className="brief-notice">
          No brief yet. {canEdit ? 'Click ✏️ to create one.' : ''}
        </div>
      )}
    </div>
  );
}
