import React, { createContext, useState, useEffect, useContext } from 'react';
import { Amplify } from 'aws-amplify';
import { 
  signIn, 
  signOut, 
  getCurrentUser, 
  fetchAuthSession, 
  fetchUserAttributes 
} from 'aws-amplify/auth';

// ─── Configure AWS Amplify ───
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID || '',
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID || '',
      signUpVerificationMethod: 'code',
      loginWith: {
        username: true,
        email: false
      }
    }
  }
});

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [tenantId, setTenantId] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);

  // Load user session on startup
  useEffect(() => {
    checkCurrentUser();
  }, []);

  const checkCurrentUser = async () => {
    try {
      const currentUser = await getCurrentUser();
      const session = await fetchAuthSession();
      const attributes = await fetchUserAttributes();

      setUser(currentUser);
      
      // Access custom claims mapping (e.g. custom:tenantId, custom:role)
      // Extract from the ID token payload or attributes mapping
      const idToken = session.tokens?.idToken;
      if (idToken) {
        setTenantId(idToken.payload['custom:tenantId'] || null);
        setRole(idToken.payload['custom:role'] || null);
      } else {
        setTenantId(attributes['custom:tenantId'] || null);
        setRole(attributes['custom:role'] || null);
      }
    } catch (error) {
      // User is not signed in
      setUser(null);
      setTenantId(null);
      setRole(null);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (username, password) => {
    setLoading(true);
    try {
      const result = await signIn({ username, password });
      await checkCurrentUser();
      return result;
    } catch (error) {
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await signOut();
      setUser(null);
      setTenantId(null);
      setRole(null);
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setLoading(false);
    }
  };

  const getAuthToken = async () => {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() || null;
    } catch (error) {
      console.error('Error fetching auth token:', error);
      return null;
    }
  };

  const value = {
    user,
    tenantId,
    role,
    loading,
    login: handleLogin,
    logout: handleLogout,
    getAuthToken
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
