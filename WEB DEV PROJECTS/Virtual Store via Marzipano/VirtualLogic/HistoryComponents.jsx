// HistoryComponents.jsx - UI components for history management
import React, { useState, useRef, useEffect } from "react"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { 
  faArrowRotateLeft, 
  faArrowRotateRight, 
  faNotesMedical,
  faChevronDown 
} from "@fortawesome/free-solid-svg-icons"

// History Toolbar Component
export const HistoryToolbar = ({ 
  historyState, 
  onUndo, 
  onRedo, 
  onJumpToHistory, 
  disabled = false 
}) => {
  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false)
  const dropdownRef = useRef(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowHistoryDropdown(false)
      }
    }

    if (showHistoryDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showHistoryDropdown])

  const formatTimestamp = (timestamp) => {
    const now = new Date()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return timestamp.toLocaleDateString()
  }

  const getActionIcon = (action) => {
    switch (action) {
      case 'create': return '+'
      case 'delete': return '−'
      case 'move': return '↻'
      case 'rotate': return '↺'
      case 'update': return '✎'
      case 'initialize': return '◉'
      default: return '•'
    }
  }

  const handleButtonClick = (e, action) => {
    e.preventDefault()
    e.stopPropagation()
    action()
  }

  return (
    <div className="HistoryToolbar">
      <button 
        className="HistoryButton HistoryUndo"
        onMouseDown={e => handleButtonClick(e, onUndo)}
        onClick={e => e.preventDefault()}
        disabled={disabled || !historyState.canUndo}
        title="Undo (Ctrl+Z)"
      >
        <FontAwesomeIcon icon={faArrowRotateLeft} />
      </button>

      <button 
        className="HistoryButton HistoryRedo"
        onMouseDown={e => handleButtonClick(e, onRedo)}
        onClick={e => e.preventDefault()}
        disabled={disabled || !historyState.canRedo}
        title="Redo (Ctrl+Y)"
      >
        <FontAwesomeIcon icon={faArrowRotateRight} />
      </button>

      <div className="HistoryDropdownContainer" ref={dropdownRef}>
        <button 
          className="HistoryButton HistoryMenu"
          onMouseDown={e => handleButtonClick(e, () => setShowHistoryDropdown(!showHistoryDropdown))}
          onClick={e => e.preventDefault()}
          disabled={disabled || historyState.history.length === 0}
          title="History"
        >
          <FontAwesomeIcon icon={faNotesMedical} />
          <FontAwesomeIcon icon={faChevronDown} className="HistoryMenuCaret" />
        </button>

        {showHistoryDropdown && (
          <div className="HistoryDropdown">
            <div className="HistoryDropdownHeader">
              <span>Action History</span>
              <span className="HistoryCount">{historyState.history.length}</span>
            </div>
            
            <div className="HistoryDropdownList">
              {historyState.history.length === 0 ? (
                <div className="HistoryDropdownEmpty">No history available</div>
              ) : (
                historyState.history.map((entry, index) => (
                  <button
                    key={entry.id}
                    className={`HistoryDropdownItem ${entry.isCurrent ? 'Current' : ''}`}
                    onMouseDown={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      onJumpToHistory(index)
                      setShowHistoryDropdown(false)
                    }}
                    onClick={e => e.preventDefault()}
                    disabled={disabled}
                  >
                    <div className="HistoryItemIcon">
                      {getActionIcon(entry.action)}
                    </div>
                    <div className="HistoryItemContent">
                      <div className="HistoryItemDescription">
                        {entry.description}
                      </div>
                      <div className="HistoryItemMeta">
                        <span className="HistoryItemScene">{entry.sceneId}</span>
                        <span className="HistoryItemTime">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                      </div>
                    </div>
                    {entry.isCurrent && (
                      <div className="HistoryItemCurrent">◉</div>
                    )}
                  </button>
                ))
              )}
            </div>

            {historyState.history.length > 0 && (
              <div className="HistoryDropdownFooter">
                <div className="HistoryDropdownInfo">
                  Step {historyState.currentIndex + 1} of {historyState.history.length}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Keyboard shortcut handler
export const useHistoryKeyboardShortcuts = (onUndo, onRedo, disabled = false) => {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (disabled) return
      
      // Ctrl+Z for undo
      if (event.ctrlKey && event.key === 'z' && !event.shiftKey) {
        event.preventDefault()
        onUndo()
        return
      }
      
      // Ctrl+Y or Ctrl+Shift+Z for redo
      if ((event.ctrlKey && event.key === 'y') || 
          (event.ctrlKey && event.shiftKey && event.key === 'z')) {
        event.preventDefault()
        onRedo()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onUndo, onRedo, disabled])
}