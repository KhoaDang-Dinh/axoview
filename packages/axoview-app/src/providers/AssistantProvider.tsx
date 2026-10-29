import { useEffect } from 'react';
import { useAppStorage } from './AppStorageContext';
import { useCognitoSessionStore } from '../stores/cognitoSessionStore';
import { useAssistantStore } from '../stores/assistantStore';
import { AssistantWidget } from '../components/ai/AssistantWidget';

/**
 * Sibling of the Cognito gate, not its child. Guests can see the assistant
 * while the gate replaces the editor. The window portal lives outside canvas
 * clipping/drag event surfaces, and the Zustand state survives route remounts.
 */
export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const { runtimeConfig, isInitialized } = useAppStorage();
  const user = useCognitoSessionStore((state) => state.user);
  const status = useCognitoSessionStore((state) => state.status);
  const activateIdentity = useAssistantStore((state) => state.activateIdentity);
  const cognito = runtimeConfig?.authMode === 'cognito';

  useEffect(() => {
    if (!isInitialized || (cognito && status === 'booting')) return;
    // Never retain an earlier user's private conversation on logout/switch.
    activateIdentity(user ? `user:${user.sub}` : 'guest');
  }, [activateIdentity, cognito, isInitialized, status, user?.sub]);

  return (
    <>
      {children}
      <AssistantWidget />
    </>
  );
}
