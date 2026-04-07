<?php

namespace App\Http\Controllers;

use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\View\View;

class ContactController extends Controller
{
    public function show(): View
    {
        return view('contact');
    }

    public function store(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'email' => ['required', 'email', 'max:255'],
            'subject' => ['nullable', 'string', 'max:200'],
            'message' => ['required', 'string', 'max:5000'],
        ]);

        Log::info('contact.form', [
            'name' => $validated['name'],
            'email' => $validated['email'],
            'subject' => $validated['subject'] ?? null,
            'message' => $validated['message'],
        ]);

        return redirect()
            ->route('contact')
            ->with('contact_sent', true);
    }
}
