<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('imvu_bots', function (Blueprint $table) {
            $table->string('proxy')->nullable()->after('password');
        });
    }

    public function down(): void
    {
        Schema::table('imvu_bots', function (Blueprint $table) {
            $table->dropColumn('proxy');
        });
    }
};
