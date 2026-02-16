import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function TaskCard({ task, isDragging, onEdit }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : 1,
  };

  const priorityColors = {
    'P0': '#ef4444',
    'P1': '#f97316',
    'P2': '#eab308',
    'P3': '#22c55e',
  };

  const creatorColors = {
    'F': '#8b5cf6', // Fran - purple
    'O': '#06b6d4', // Ocean - cyan
    'K': '#f97316', // Krill - orange
    'P': '#ec4899', // Pierre - pink
    'H': '#10b981', // Hubert - green
    'S': '#3b82f6', // S - blue
  };

  const priority = task.metadata?.priority || '';
  const priorityColor = priorityColors[priority] || '#888';
  
  // Creator initial
  const creator = task.metadata?.creator?.charAt(0)?.toUpperCase() || '';
  const creatorColor = creatorColors[creator] || '#64748b';
  
  // Build display ID with project prefix
  // Convert TASK-001 to PROJECT-001 format
  const projectPrefix = task._project?.toUpperCase() || '';
  const taskNum = task.id.replace('TASK-', '');
  const displayId = projectPrefix ? `${projectPrefix}-${taskNum}` : task.id;

  // Tags that need attention highlighting
  const attentionTags = ['#needs-human', '#needs-review', '#review', '#blocked', '#urgent', '#help'];
  
  function isAttentionTag(tag) {
    const lowerTag = tag.toLowerCase();
    return attentionTags.some(t => lowerTag.includes(t.replace('#', '')));
  }

  function handleExpand(e) {
    e.stopPropagation();
    e.preventDefault();
    if (onEdit && !isDragging) {
      onEdit();
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`task-card ${isDragging ? 'dragging' : ''}`}
    >
      <div className="task-header">
        <div className="task-header-left">
          {creator && (
            <span 
              className="task-creator" 
              style={{ backgroundColor: creatorColor }}
            >
              {creator}
            </span>
          )}
          <span className="task-id">{displayId}</span>
        </div>
        <div className="task-header-right">
          {priority && (
            <span 
              className="task-priority" 
              style={{ backgroundColor: priorityColor }}
            >
              {priority}
            </span>
          )}
          <button 
            className="expand-btn" 
            onClick={handleExpand}
            onPointerDown={e => e.stopPropagation()}
            title="View details"
          >
            ↗
          </button>
        </div>
      </div>
      
      <div className="task-title">{task.title}</div>
      
      <div className="task-footer">
        <div className="task-tags">
          {task.metadata?.tags?.split(' ').map((tag, i) => (
            <span key={i} className={`tag ${isAttentionTag(tag) ? 'attention' : ''}`}>{tag}</span>
          ))}
        </div>
        {task.metadata?.closed ? (
          <span className="task-closed">Closed by {task.metadata.closed.replace(/^\d{4}-\d{2}-\d{2}\s+by\s+/i, '')}</span>
        ) : task.metadata?.assigned && (
          <span className="task-assigned">{task.metadata.assigned}</span>
        )}
      </div>
    </div>
  );
}

export default TaskCard;
