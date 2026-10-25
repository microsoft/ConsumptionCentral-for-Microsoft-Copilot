import { Component, type ReactNode } from 'react'
import { Note } from './primitives'

/** Keeps one view's render error inside that view, so the header, tabs and other views still work. */
export class ErrorBoundary extends Component<{ resetKey: unknown; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown) {
    console.error(error)
  }

  componentDidUpdate(prev: { resetKey: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <Note tone="warn" title="This view couldn't be shown">
        Something in the loaded data stopped this view from drawing. The other tabs still work. Details: {this.state.error.message}
      </Note>
    )
  }
}
