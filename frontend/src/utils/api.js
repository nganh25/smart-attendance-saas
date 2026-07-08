import { fetchAuthSession } from 'aws-amplify/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://your-api-gateway.amazonaws.com';

/**
 * Helper to fetch a fresh JWT session token.
 */
async function getAuthToken() {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() || null;
  } catch (error) {
    console.error('Session retrieval failed:', error);
    return null;
  }
}

/**
 * Standardized API client wrapper targeting the secure backend.
 */
export async function apiRequest(endpoint, options = {}) {
  const token = await getAuthToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  // Automatically inject Bearer Token if user session is active
  if (token) {
    headers['Authorization'] = `${token}`;
  }

  const config = {
    ...options,
    headers,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const error = new Error(errorData.message || 'API request failed');
    error.status = response.status;
    throw error;
  }

  return response.json();
}
