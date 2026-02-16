import { useState, useEffect } from 'react';

const API_BASE = '';

export default function BriefModal({ projectId, projectName, canEdit, onClose }) {
  const [content, setContent] = useState('');
  const [exists, setExists] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchBrief();
  }, [projectId]);

  async function fetchBrief() {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/brief`, {
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setContent(data.content);
        setExists(data.exists);
      } else {
        setError('Failed to load brief');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/brief`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (res.ok) {
        setExists(true);
        setEditing(false);
      } else {
        setError('Failed to save brief');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // Simple markdown to HTML (headers, bold, lists, links)
  function renderMarkdown(md) {
    if (!md) return '';
    
    return md
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Blockquotes
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      // List items
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      // Wrap consecutive li in ul
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      // Paragraphs (lines with content not already tagged)
      .split('\n\n')
      .map(p => {
        if (p.startsWith('<') || p.trim() === '') return p;
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal brief-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📄 {projectName} Brief</h2>
          <div className="modal-actions">
            {canEdit && !editing && (
              <button onClick={() => setEditing(true)} className="btn-secondary">
                ✏️ Edit
              </button>
            )}
            <button onClick={onClose} className="btn-close">×</button>
          </div>
        </div>

        {error && <div className="error-msg">{error}</div>}

        <div className="modal-content">
          {editing ? (
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              className="brief-editor"
              placeholder="# Project: Name&#10;&#10;> Description&#10;&#10;## Resources&#10;- **Domain**: example.com"
            />
          ) : (
            <div 
              className="brief-preview markdown-content"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          )}
        </div>

        {editing && (
          <div className="modal-footer">
            <button onClick={() => setEditing(false)} className="btn-secondary">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving} className="btn-primary">
              {saving ? 'Saving...' : 'Save Brief'}
            </button>
          </div>
        )}

        {!exists && !editing && (
          <div className="brief-notice">
            ℹ️ No brief exists yet. {canEdit ? 'Click Edit to create one.' : 'An editor can create one.'}
          </div>
        )}
      </div>
    </div>
  );
}
