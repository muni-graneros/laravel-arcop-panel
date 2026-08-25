<?php

namespace Muni\Arcop\Http\Controllers;

use Muni\Shared\Privacidad\Ciclo\EntregaDeCopia;
use Muni\Shared\Privacidad\Contratos\RegistroDeEvidencia;
use Muni\Shared\Privacidad\ExportacionDeDatos;
use Muni\Shared\Privacidad\Modelos\Solicitud;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * La descarga del expediente ARCOP.
 *
 * Por stream y nunca escrito en `public/`: es un documento con los datos
 * personales de un vecino, y un archivo dejado en el directorio público queda
 * accesible para cualquiera que adivine el nombre y, peor, indexable.
 *
 * La descarga queda registrada. Ese registro es de las dos partes: prueba que el
 * municipio le entregó lo que pidió, y deja anotado quién se llevó una copia de
 * los datos de esa persona.
 */
class ExpedienteController extends Controller
{
    public function descargar(Solicitud $solicitud, RegistroDeEvidencia $evidencia): StreamedResponse
    {
        $solicitud->loadMissing('titular');

        // Segunda guardia, a propósito. La vista ya oculta el botón cuando la
        // copia no procede, pero una URL se escribe a mano: sin esto, pedir el
        // expediente de una supresión devolvía un 500 con la traza a la vista en
        // vez de una negativa. El motivo es el del módulo, tal cual.
        $motivo = EntregaDeCopia::porQueNo($solicitud);

        abort_if($motivo !== null, 403, $motivo);

        $contenido = json_encode(
            app(ExportacionDeDatos::class)->paraSolicitud($solicitud),
            JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
        );

        $evidencia->registrar('arcop.expediente.descargado', [
            'solicitud_id' => $solicitud->getKey(),
        ], $solicitud->titular);

        $nombre = 'expediente-arcop-'.$solicitud->getKey().'.json';

        return response()->streamDownload(function () use ($contenido): void {
            echo $contenido;
        }, $nombre, [
            'Content-Type' => 'application/json; charset=utf-8',
            // Un expediente con datos de un vecino no lo guarda ningún
            // intermediario ni queda en el historial del navegador compartido
            // de una oficina.
            'Cache-Control' => 'no-store, max-age=0',
        ]);
    }
}
