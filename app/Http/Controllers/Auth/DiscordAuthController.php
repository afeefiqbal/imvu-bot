<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class DiscordAuthController extends Controller
{
    public function redirect(Request $request): RedirectResponse
    {
        $this->ensureDiscordIsConfigured();

        $state = Str::random(40);
        $request->session()->put('discord_oauth_state', $state);

        return redirect()->away('https://discord.com/oauth2/authorize?'.http_build_query([
            'client_id' => config('services.discord.client_id'),
            'redirect_uri' => config('services.discord.redirect'),
            'response_type' => 'code',
            'scope' => 'identify email',
            'state' => $state,
        ]));
    }

    public function callback(Request $request): RedirectResponse
    {
        $this->ensureDiscordIsConfigured();

        if (! hash_equals((string) $request->session()->pull('discord_oauth_state'), (string) $request->query('state'))) {
            throw ValidationException::withMessages([
                'discord' => 'Discord login state was invalid. Please try again.',
            ]);
        }

        $tokenResponse = Http::asForm()->post('https://discord.com/api/oauth2/token', [
            'client_id' => config('services.discord.client_id'),
            'client_secret' => config('services.discord.client_secret'),
            'grant_type' => 'authorization_code',
            'code' => $request->query('code'),
            'redirect_uri' => config('services.discord.redirect'),
        ])->throw()->json();

        $discordUser = Http::withToken($tokenResponse['access_token'])
            ->get('https://discord.com/api/users/@me')
            ->throw()
            ->json();

        $discordId = (string) $discordUser['id'];
        $email = $discordUser['email'] ?? "discord-{$discordId}@discord.local";

        $user = User::query()
            ->where('discord_id', $discordId)
            ->orWhere('email', $email)
            ->first();

        if (! $user) {
            $user = new User;
            $user->password = Str::random(48);
        }

        $user->fill([
            'name' => $discordUser['global_name'] ?? $discordUser['username'] ?? 'Discord User',
            'discord_id' => $discordId,
            'email' => $email,
            'email_verified_at' => now(),
        ]);
        $user->save();

        Auth::login($user, remember: true);

        return redirect()->intended(route('dashboard'));
    }

    public function logout(Request $request): RedirectResponse
    {
        Auth::logout();

        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect()->route('home');
    }

    private function ensureDiscordIsConfigured(): void
    {
        abort_unless(
            filled(config('services.discord.client_id'))
                && filled(config('services.discord.client_secret'))
                && filled(config('services.discord.redirect')),
            503,
            'Discord login is not configured.',
        );
    }
}
