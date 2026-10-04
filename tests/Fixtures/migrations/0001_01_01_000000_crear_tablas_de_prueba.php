<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('usuarios_de_prueba', function (Blueprint $tabla): void {
            $tabla->id();
            $tabla->string('name');
            $tabla->string('email')->unique();
            $tabla->string('password')->nullable();
            $tabla->timestamps();
        });

        Schema::create('vecinos_de_prueba', function (Blueprint $tabla): void {
            $tabla->id();
            $tabla->string('nombre');
            $tabla->string('documento');
            $tabla->string('correo')->nullable();
            $tabla->string('observacion')->nullable();
            $tabla->date('fecha_nacimiento')->nullable();
            $tabla->timestamps();
        });

        // Una tabla del sistema adoptante con su propia noción de «solicitud»,
        // ajena al módulo de privacidad.
        Schema::create('solicitudes_ajenas', function (Blueprint $tabla): void {
            $tabla->id();
            $tabla->string('nombre');
            $tabla->timestamps();
        });
    }
};
