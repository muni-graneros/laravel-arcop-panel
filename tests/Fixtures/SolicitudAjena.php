<?php

namespace Muni\Arcop\Tests\Fixtures;

use Illuminate\Database\Eloquent\Model;

/**
 * Una «solicitud» del sistema adoptante que no tiene nada que ver con ARCOP
 * —la de licencias de conducir, por ejemplo—, con su propia ruta `{solicitud}`.
 *
 * Existe para probar que el paquete no le secuestra el binding de ese
 * parámetro a la aplicación que lo instala.
 */
class SolicitudAjena extends Model
{
    protected $table = 'solicitudes_ajenas';

    protected $guarded = [];
}
