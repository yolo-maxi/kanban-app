import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import TaskCard from './TaskCard';

function Column({ column, onAddTask, onEditTask, showProject }) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id
  });

  return (
    <div className={`column ${isOver ? 'column-over' : ''}`}>
      <div className="column-header">
        <h2 className="column-title">{column.title}</h2>
        <div className="column-actions">
          <span className="task-count">{column.tasks.length}</span>
          <button className="add-task-btn" onClick={onAddTask}>+</button>
        </div>
      </div>
      
      <div className="column-content" ref={setNodeRef}>
        <SortableContext
          items={column.tasks.map(t => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {column.tasks.map(task => (
            <TaskCard 
              key={task.id} 
              task={task} 
              showProject={showProject}
              onEdit={() => onEditTask(task)}
            />
          ))}
        </SortableContext>
        
        {column.tasks.length === 0 && (
          <div className="empty-column">Drop tasks here</div>
        )}
      </div>
    </div>
  );
}

export default Column;
