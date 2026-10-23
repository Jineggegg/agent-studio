const form = document.querySelector('#connect');
const field = document.querySelector('#url');
const status = document.querySelector('#status');
const button = form.querySelector('button');
void window.cloudHarnessDesktop.connection().then((value) => {
  field.value = value?.url ?? '';
  status.textContent = value?.error ?? '';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = 'Connecting… / 正在连接…';
  try {
    const result = await window.cloudHarnessDesktop.connect(field.value);
    if (result?.error) status.textContent = result.error;
  } catch {
    status.textContent =
      'Could not connect. Check the URL and try again. / 无法连接，请检查地址后重试。';
  } finally {
    button.disabled = false;
  }
});
