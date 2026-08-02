// EditorUIComponents.js - Toast and Modal components
import React, { useState, useEffect, useRef } from 'react'
// Toast Context and Hook
export const ToastContext = React.createContext()

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([])
  const nextIdRef = useRef(1)

  const addToast = (message, type = 'info', duration = 4000) => {
    const id = nextIdRef.current++
    const toast = { id, message, type, duration }
    setToasts(prev => [...prev, toast])

    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id))
      }, duration)
    }

    return id
  }

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  const showSuccess = (message) => addToast(message, 'success')
  const showError = (message) => addToast(message, 'error')
  const showInfo = (message) => addToast(message, 'info')

  return (
    <ToastContext.Provider value={{ addToast, removeToast, showSuccess, showError, showInfo }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  )
}

export const useToast = () => {
  const context = React.useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

// Toast Container Component
const ToastContainer = ({ toasts, onRemove }) => {
  if (toasts.length === 0) return null

  return (
    <div className="ToastContainer">
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onClose={() => onRemove(toast.id)} />
      ))}
    </div>
  )
}

// Individual Toast Component
const Toast = ({ toast, onClose }) => {
  const { message, type } = toast

  const getIcon = () => {
    switch (type) {
      case 'success': return '✓'
      case 'error': return '✕'
      case 'info': return 'ℹ'
      default: return 'ℹ'
    }
  }

  return (
    <div className={`Toast ${type.charAt(0).toUpperCase() + type.slice(1)}`}>
      <div className="ToastIcon">{getIcon()}</div>
      <div className="ToastMessage">{message}</div>
      <button className="ToastCloseBtn" onClick={onClose}>×</button>
    </div>
  )
}

// Global Busy Overlay
export const GlobalBusyOverlay = ({ show, label = 'Saving...' }) => {
  const overlayRef = useRef(null)

  useEffect(() => {
    if (show && overlayRef.current) {
      overlayRef.current.focus()
    }
  }, [show])

  useEffect(() => {
    if (show) {
      const handleKeyDown = (e) => {
        // Trap focus and prevent escape while busy
        e.preventDefault()
        e.stopPropagation()
      }
      
      document.addEventListener('keydown', handleKeyDown, true)
      return () => document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [show])

  if (!show) return null

  return (
    <div 
      className="GlobalBusyOverlay" 
      ref={overlayRef}
      tabIndex={-1}
      role="dialog" 
      aria-modal="true"
      aria-label={label}
    >
      <div className="GlobalBusyContent">
        <div className="GlobalBusySpinner"></div>
        <p className="GlobalBusyText">{label}</p>
      </div>
    </div>
  )
}
// Confirmation Modal
export const ConfirmModal = ({
  show,
  title,
  children,
  onConfirm,
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmVariant = 'danger',
  isLoading = false
}) => {
  const modalRef = useRef(null)

  useEffect(() => {
    if (show && modalRef.current) modalRef.current.focus()
  }, [show])

  useEffect(() => {
    if (!show) return
    const onKey = e => { if (e.key === 'Escape' && !isLoading) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [show, isLoading, onCancel])

  if (!show) return null

  const stop = e => e.stopPropagation()

  return (
    <div className="ConfirmModalOverlay" onClick={() => { if (!isLoading) onCancel() }}>
      <div
        className="ConfirmModalBox"
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={stop}
        aria-busy={isLoading ? 'true' : 'false'}
      >
        <div className="ConfirmModalHeader">
          <h3 id="confirm-title">{title}</h3>
          <button
            className="ConfirmModalCloseBtn"
            onClick={onCancel}
            aria-label="Close"
            disabled={isLoading}
          >×</button>
        </div>

        <div className="ConfirmModalBody">
          {children}
        </div>

        <div className="ConfirmModalFooter">
          <button
            className="ConfirmModalCancelBtn"
            onClick={onCancel}
            disabled={isLoading}
          >{cancelText}</button>
          <button
            className={`ConfirmModalConfirmBtn ${confirmVariant === 'primary' ? 'Primary' : ''}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? 'Working…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}


// Busy utility wrapper
export const withBusy = (asyncFn, label, setBusy, toast) => {
  const isRedo = typeof label === 'string' && label.toLowerCase().includes('redo')
  return async (...args) => {
    try {
      if (!isRedo) setBusy(label)
      const result = await asyncFn(...args)

      const successMessage = getSuccessMessage(label)
      if (successMessage) toast.showSuccess(successMessage)

      return result
    } catch (error) {
      console.error(`${label} failed:`, error)
      const errorMessage = getErrorMessage(label, error)
      toast.showError(errorMessage)
      throw error
    } finally {
      if (!isRedo) setBusy(null)
    }
  }
}
const getSuccessMessage = (label) => {
  const lower = label.toLowerCase()
  if (lower.includes('upload')) return 'Image uploaded successfully!'
  if (lower.includes('publish')) return 'Tour published successfully!'
  if (lower.includes('save') || lower.includes('saving')) return 'Changes saved!'
  if (lower.includes('delet')) return 'Deleted successfully!'
  if (lower.includes('renam')) return 'Renamed successfully!'
  if (lower.includes('mov')) return 'Hotspot moved!'
  return 'Operation completed!'
}

const getErrorMessage = (label, error) => {
  const lower = label.toLowerCase()
  if (lower.includes('upload')) return 'Failed to upload image. Please try again.'
  if (lower.includes('publish')) return 'Failed to publish tour. Please try again.'
  if (lower.includes('save') || lower.includes('saving')) return 'Failed to save changes. Please try again.'
  if (lower.includes('delet')) return 'Failed to delete. Please try again.'
  if (lower.includes('renam')) return 'Failed to rename. Please try again.'
  if (lower.includes('mov')) return 'Failed to move hotspot. Please try again.'
  return 'Operation failed. Please try again.'
}

export const LiveViewDisplay = ({ view }) => {
  const fmt = v => (v * 180 / Math.PI).toFixed(1)
  if (!view) return <div className="LiveViewDisplay">Current: Yaw 0.0°, Pitch 0.0°, FOV 0.0°</div>
  return (
    <div className="LiveViewDisplay">
      Current: Yaw {fmt(view.yaw)}°, Pitch {fmt(view.pitch)}°, FOV {fmt(view.fov)}°
    </div>
  )
}