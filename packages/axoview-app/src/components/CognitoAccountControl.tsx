import { useState } from 'react';
import { Button, Menu, MenuItem } from '@mui/material';
import { useAppStorage } from '../providers/AppStorageContext';
import { signOutCognito, useCognitoSessionStore } from '../stores/cognitoSessionStore';

export function CognitoAccountControl() {
  const { runtimeConfig } = useAppStorage();
  const user = useCognitoSessionStore((state) => state.user);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (runtimeConfig?.authMode !== 'cognito' || !user) return null;
  return (
    <>
      <Button
        size="small"
        color="inherit"
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-label="Account menu"
        data-axoview-id="cognito-account"
      >
        {user.username || user.sub.slice(0, 8)}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem
          onClick={() => {
            setAnchor(null);
            void signOutCognito();
          }}
        >
          Sign out
        </MenuItem>
      </Menu>
    </>
  );
}
