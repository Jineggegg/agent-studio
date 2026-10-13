import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/http';
import { resetSessionStore, useSession } from '@/data/session';
import { renderInApp } from '@/test/render';
import LoginScreen from './LoginScreen';

const signIn = vi.fn();
vi.mock('@/data/auth', () => ({ signIn: (credentials: unknown) => signIn(credentials) }));

beforeEach(() => {
  signIn.mockReset();
  resetSessionStore();
});

const fill = async (user: ReturnType<typeof userEvent.setup>, username: string, password: string) => {
  if (username) await user.type(screen.getByLabelText('Username'), username);
  if (password) await user.type(screen.getByLabelText('Password'), password);
};

describe('the sign-in form', () => {
  it('has fields a password manager can fill, and no dead buttons', () => {
    renderInApp(<LoginScreen />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocapitalize', 'none');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    // no passkey button unless a sign-in method registered one and it can work here
    expect(screen.queryByRole('button', { name: /passkey/i })).not.toBeInTheDocument();
    expect(document.querySelector('.auth__methods')).toBeEmptyDOMElement();
  });

  it('asks for both fields before sending anything', async () => {
    const user = userEvent.setup();
    renderInApp(<LoginScreen />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your username and password.');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('signs in with the trimmed username and shows it is working', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    signIn.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    renderInApp(<LoginScreen />);
    await fill(user, '  ada  ', 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(signIn).toHaveBeenCalledWith({ username: 'ada', password: 'correct horse battery' });
    const button = screen.getByRole('button', { name: /Signing in/ });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText('Username')).toBeDisabled();
    finish();
  });

  it('submits on Enter', async () => {
    const user = userEvent.setup();
    signIn.mockResolvedValue(undefined);
    renderInApp(<LoginScreen />);
    await fill(user, 'ada', 'secret password');
    await user.keyboard('{Enter}');
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('never submits on the Enter that confirms an input-method candidate', async () => {
    const user = userEvent.setup();
    renderInApp(<LoginScreen />);
    await fill(user, '小宋', 'secret password');
    const field = screen.getByLabelText('Username');
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(field);
    // Safari reports the confirming Enter after composition has ended, still with key code 229
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('gives one generic message for any refused credentials and keeps what was typed', async () => {
    const user = userEvent.setup();
    signIn.mockRejectedValue(new ApiError(401, 'invalid_credentials', 'That username or password is not correct.'));
    renderInApp(<LoginScreen />);
    await fill(user, 'ada', 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That username or password is not correct.');
    expect(screen.getByLabelText('Username')).toHaveValue('ada');
    expect(screen.getByLabelText('Password')).toHaveValue('wrong password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('says when to try again after too many attempts, and waits until then', async () => {
    const user = userEvent.setup();
    signIn.mockRejectedValue(new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Try again later.', { retryAfterSeconds: 120 }));
    renderInApp(<LoginScreen />);
    await fill(user, 'ada', 'whatever it is');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Too many attempts\. Try again at \d{1,2}:\d{2}/);
    expect(alert).toHaveTextContent('2 minutes');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('distinguishes an unreachable server from a wrong password', async () => {
    const user = userEvent.setup();
    signIn.mockRejectedValue(new ApiError(0, 'network_error', 'Failed to fetch'));
    renderInApp(<LoginScreen />);
    await fill(user, 'ada', 'whatever it is');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('explains an expired session when that is why the form is showing', async () => {
    useSession.setState({ status: 'ready', endReason: 'expired' });
    renderInApp(<LoginScreen />);
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended');
    await waitFor(() => expect(document.title).toBe('Sign in · Agent Studio'));
  });

  it('can show and hide the password', async () => {
    const user = userEvent.setup();
    renderInApp(<LoginScreen />);
    await fill(user, '', 'visible?');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });
});
