import type { Root, Subscriber } from '@minamorl/root-core';
import type { Cray } from './core';
import { compile, execute } from './graph';

/**
 * Options for configuring the Root-Cray bridge
 */
export interface BridgeOptions<TransformedState = Record<string, unknown>, WorkflowState = TransformedState> {
  /** State transformation function from Root to Cray context (required for type safety) */
  stateTransform: (rootState: Record<string, unknown>) => TransformedState;
  /** Execute workflow on initial subscription (default: false) */
  runOnSubscribe?: boolean;
  /** Target ID for storing workflow results (default: 'computed') */
  target?: string;
  /** Error callback function */
  onError?: (error: unknown, state: WorkflowState | null) => void;
  /** Commit errors to Root state (default: false) */
  commitError?: boolean;
  /** Debounce time in milliseconds (default: 0) */
  debounce?: number;
}

/**
 * Attaches a Cray workflow to a Root instance, creating a reactive bridge that:
 * - Subscribes to Root state changes
 * - Executes the Cray workflow with the transformed state
 * - Commits successful results back to Root
 * - Handles errors according to configuration
 * 
 * Note: This is a unidirectional reactive bridge (Root → Cray → Root)
 * 
 * @param root - The Root instance to bridge with
 * @param workflow - The Cray workflow to execute
 * @param options - Configuration options including required state transformation
 * @returns Unsubscribe function to stop the bridge
 */
export function attachCray<S, E, T = S>(
  root: Root,
  workflow: Cray<S, E>,
  options: BridgeOptions<T, S>
): () => void {
  const {
    stateTransform,
    runOnSubscribe = false,
    target = 'computed',
    onError,
    commitError = false,
    debounce = 0
  } = options;

  let isFirstEvent = true;
  let debounceTimer: NodeJS.Timeout | null = null;
  let isExecuting = false;
  let unsubscribed = false;
  let pendingState: S | null = null;
  const suppressedEvents = new Map<string, number>();

  const suppressEvent = (id: string) => {
    suppressedEvents.set(id, (suppressedEvents.get(id) ?? 0) + 1);
  };

  const consumeSuppressedEvent = (id: string) => {
    const count = suppressedEvents.get(id);
    if (!count) {
      return false;
    }

    if (count === 1) {
      suppressedEvents.delete(id);
    } else {
      suppressedEvents.set(id, count - 1);
    }

    return true;
  };

  // Compile workflow to graph for execution
  const graph = compile([workflow]);

  // Execute workflow with current state
  const executeWorkflow = async (state: S) => {
    if (unsubscribed) return;

    if (isExecuting) {
      pendingState = state;
      return;
    }

    isExecuting = true;
    try {
      const result = await execute(graph, state);
      
      if (unsubscribed) return; // Check again after async operation
      
      if (result.ok) {
        // Commit successful result to Root
        suppressEvent(target);
        root.commit({
          type: 'Update',
          id: target,
          value: result.state
        });
      } else {
        // Handle workflow error
        if (onError) {
          onError(result.error, result.state);
        }
        
        if (commitError && target !== 'workflow:error') {
          suppressEvent('workflow:error');
          root.commit({
            type: 'Update',
            id: 'workflow:error',
            value: {
              error: result.error,
              timestamp: Date.now(),
              workflowId: target
            }
          });
        }
      }
    } catch (error) {
      if (unsubscribed) return;
      
      // Handle unexpected errors
      const errorValue = error as E;
      if (onError) {
        onError(errorValue, state);
      }
      
      if (commitError && target !== 'workflow:error') {
        suppressEvent('workflow:error');
        root.commit({
          type: 'Update',
          id: 'workflow:error',
          value: {
            error: errorValue,
            timestamp: Date.now(),
            workflowId: target
          }
        });
      }
    } finally {
      isExecuting = false;
      if (pendingState && !unsubscribed) {
        const nextState = pendingState;
        pendingState = null;
        await executeWorkflow(nextState);
      }
    }
  };

  // Handle state change events with type-safe transformation
  const handleStateChange = () => {
    if (unsubscribed) return;
    
    try {
      const rootState = root.state();
      const transformedState = stateTransform(rootState) as unknown as S;
      
      if (debounce > 0) {
        // Clear existing timer
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        
        // Set new timer
        debounceTimer = setTimeout(() => {
          if (!unsubscribed) {
            void executeWorkflow(transformedState);
          }
        }, debounce);
      } else {
        // Execute immediately
        void executeWorkflow(transformedState);
      }
    } catch (transformError) {
      // Handle state transformation errors
      if (onError) {
        onError(transformError, null);
      }
      
      if (commitError && target !== 'workflow:error') {
        root.commit({
          type: 'Update',
          id: 'workflow:error',
          value: {
            error: transformError,
            timestamp: Date.now(),
            workflowId: target,
            phase: 'state_transformation'
          }
        });
      }
    }
  };

  // Subscribe to Root events
  const subscriber: Subscriber = (event) => {
    if (unsubscribed) return;
    
    // Ignore error updates to avoid feedback loops
    if (event.type !== 'Snapshot' && 'id' in event && event.id === 'workflow:error') {
      return;
    }

    if (event.type !== 'Snapshot' && 'id' in event && typeof event.id === 'string') {
      if (consumeSuppressedEvent(event.id)) {
        return;
      }
    }

    if (event.type === 'Snapshot') {
      // Handle initial snapshot - consistent with state change semantics
      if (isFirstEvent) {
        isFirstEvent = false;
        if (runOnSubscribe) {
          handleStateChange();
        }
        return;
      }
      // Handle subsequent snapshots (from compact)
      handleStateChange();
      return;
    }
    
    // Handle regular events (Create, Update, Delete)
    handleStateChange();
  };

  const unsubscribe = root.subscribe(subscriber);

  // Return unsubscribe function with cleanup
  return () => {
    unsubscribed = true;
    unsubscribe();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    suppressedEvents.clear();
  };
}
