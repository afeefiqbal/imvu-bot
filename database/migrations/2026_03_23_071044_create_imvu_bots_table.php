<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('imvu_bots', function (Blueprint $table) {
            $table->id();
            $table->string('name')->unique();
            $table->string('username');
            $table->string('password');
            $table->text('room_ids')->nullable(); // Comma-separated or JSON list of rooms to join
            $table->boolean('is_active')->default(true);
            $table->string('current_room_id')->nullable();
            $table->boolean('ai_enabled')->default(true);
            $table->boolean('spam_enabled')->default(false);
            $table->timestamp('last_seen_at')->nullable();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('imvu_bots');
    }
};
