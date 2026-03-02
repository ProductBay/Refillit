export async function apiFetch({ apiBase, token, path, method = "GET", body }) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_error) {
    const error = new Error(`Network error: unable to reach API at ${apiBase}`);
    error.status = 0;
    error.payload = null;
    throw error;
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }
  if (!response.ok) {
    const message = data?.error || `${response.status} ${response.statusText}`;
    if (response.status === 401) {
      localStorage.removeItem("refillit_auth");
      window.dispatchEvent(new Event("refillit:unauthorized"));
    }
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}
