<?php

namespace Muni\Arcop\Tests\Fixtures;

use Illuminate\Database\Eloquent\Model;
use Muni\Shared\Privacidad\Contratos\TitularDeDatos;

/**
 * Titular mínimo del adoptante: lo que el paquete conoce es el contrato, nunca
 * este modelo.
 */
class VecinoDePrueba extends Model implements TitularDeDatos
{
    protected $table = 'vecinos_de_prueba';

    protected $guarded = [];

    public bool $sensiblesPurgados = false;

    public bool $fueAnonimizado = false;

    public function titularNombre(): string
    {
        return (string) $this->nombre;
    }

    public function titularDocumento(): string
    {
        return (string) $this->documento;
    }

    /** @return array<string, mixed> */
    public function exportarDatosPersonales(): array
    {
        return ['nombre' => $this->nombre, 'documento' => $this->documento, 'correo' => $this->correo];
    }

    public function purgarDatosSensibles(): void
    {
        $this->forceFill(['observacion' => null])->save();
        $this->sensiblesPurgados = true;
    }

    public function anonimizar(): void
    {
        $this->forceFill(['nombre' => 'Anonimizado', 'documento' => 'ANON-'.$this->getKey(), 'correo' => null])->save();
        $this->fueAnonimizado = true;
    }

    /** @return array<int, string> */
    public function camposRectificables(): array
    {
        return ['nombre', 'correo'];
    }

    public function fechaNacimientoTitular(): ?\DateTimeInterface
    {
        return $this->fecha_nacimiento ? new \DateTimeImmutable((string) $this->fecha_nacimiento) : null;
    }
}
