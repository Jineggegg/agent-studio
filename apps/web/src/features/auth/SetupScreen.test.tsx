import { PASSWORD_MIN_LENGTH } from '@agent-studio/protocol';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/http';
import { renderInApp } from '@/test/render';
import SetupScreen from './SetupScreen';

const setUp = vi.fn();
vi.mock('@/data/auth', () => ({ setUp: (input: unknown) => setUp(input) }));

beforeEach(() => setUp.mockReset());

const GOOD_PASSWORD = 'a sentence I will remember';

async function fill(user: ReturnType<typeof userEvent.setup>, values: { token?: string; username?: string; name?: string; password?: string; again?: string }) {
  if (values.token) await user.type(screen.getByLabelText('Setup token'), values.token);
  if (values.username) await user.type(screen.getByLabelText('Username'), values.username);
  if (values.name) await user.type(screen.getByLabelText(/Display name/), values.name);
  if (values.password) await user.type(screen.getByLabelText('Password'), values.password);
  if (values.again) await user.type(screen.getByLabelText('Password again'), values.again);
}

describe('first-run setup', () => {
  it('asks for the setup token, a username and a password twice, with hints for password managers', () => {
    renderInApp(<SetupScreen />);
    expect(screen.getByRole('heading', { name: 'Set up your Studio' })).toBeInTheDocument();
    expect(screen.getByLabelText('Setup token')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Password again')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByText(new RegExp(`At least ${PASSWORD_MIN_LENGTH} characters`))).toBeInTheDocument();
  });

  it('points at every field that is missing and sends nothing', async () => {
    const user = userEvent.setup();
    renderInApp(<SetupScreen />);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Enter the setup token.')).toBeInTheDocument();
    expect(screen.getByText('Enter a username.')).toBeInTheDocument();
    expect(screen.getByText('Enter a password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
    expect(setUp).not.toHaveBeenCalled();
  });

  it("applies the server's rules before sending: username shape, password length, matching passwords", async () => {
    const user = userEvent.setup();
    renderInApp(<SetupScreen />);
    await fill(user, { token: 'tok', username: '-bad name', password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1), again: 'different' });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText(/Use letters, digits, dots, dashes and underscores/)).toBeInTheDocument();
    expect(screen.getByText(`Use at least ${PASSWORD_MIN_LENGTH} characters.`)).toBeInTheDocument();
    expect(setUp).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Username'));
    await user.type(screen.getByLabelText('Username'), 'a');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), GOOD_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Use at least 2 characters.')).toBeInTheDocument();
    expect(screen.getByText('The two passwords are not the same.')).toBeInTheDocument();
    expect(setUp).not.toHaveBeenCalled();
  });

  it('creates the owner with trimmed values, leaving out an empty display name', async () => {
    const user = userEvent.setup();
    setUp.mockResolvedValue(undefined);
    renderInApp(<SetupScreen />);
    await fill(user, { token: '  local-setup-token-123456 ', username: ' owner ', password: GOOD_PASSWORD, again: GOOD_PASSWORD });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(setUp).toHaveBeenCalledWith({ setupToken: 'local-setup-token-123456', username: 'owner', password: GOOD_PASSWORD });
  });

  it('sends the display name when one is given', async () => {
    const user = userEvent.setup();
    setUp.mockResolvedValue(undefined);
    renderInApp(<SetupScreen />);
    await fill(user, { token: 'tok-123', username: 'owner', name: ' Ada L. ', password: GOOD_PASSWORD, again: GOOD_PASSWORD });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(setUp).toHaveBeenCalledWith({ setupToken: 'tok-123', username: 'owner', password: GOOD_PASSWORD, displayName: 'Ada L.' });
  });

  it('puts a wrong setup token and a weak password next to the field they concern', async () => {
    const user = userEvent.setup();
    renderInApp(<SetupScreen />);
    await fill(user, { token: 'wrong', username: 'owner', password: GOOD_PASSWORD, again: GOOD_PASSWORD });

    setUp.mockRejectedValueOnce(new ApiError(403, 'invalid_setup_token', 'That setup token is not correct.'));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/That setup token is not correct/)).toBeInTheDocument();
    expect(screen.getByLabelText('Setup token')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();

    setUp.mockRejectedValueOnce(new ApiError(400, 'weak_password', 'That password is too easy to guess. Choose another.'));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/too easy to guess/)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains refusals that are not about a field: already set up, throttled, unreachable', async () => {
    const user = userEvent.setup();
    renderInApp(<SetupScreen />);
    await fill(user, { token: 'tok-123', username: 'owner', password: GOOD_PASSWORD, again: GOOD_PASSWORD });

    setUp.mockRejectedValueOnce(new ApiError(409, 'already_set_up', 'This Studio is already set up.'));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('This Studio is already set up. Sign in instead.')).toBeInTheDocument();

    setUp.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'Too many attempts.', { retryAfterSeconds: 30 }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/Too many attempts\. Try again at/)).toBeInTheDocument();

    setUp.mockRejectedValueOnce(new ApiError(0, 'network_error', 'Failed to fetch'));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/The server could not be reached/)).toBeInTheDocument();
  });
});
